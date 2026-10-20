/**
 * Turnover Desk lead outreach.
 *
 * Lives in a Google Sheet (Extensions → Apps Script). Every day it:
 *   1. finds short-term rental managers on Google Maps (Places API),
 *   2. pulls a contact email from each company's website,
 *   3. sends a short email sequence from your Gmail, follow-ups in the same thread,
 *   4. tracks replies, bounces, unsubscribes and (optionally) opens in the sheet.
 *
 * Setup steps are in README.md next to this file.
 */

const SHEETS = {
  dashboard: 'Dashboard',
  leads: 'Leads',
  searches: 'Searches',
  templates: 'Templates',
  settings: 'Settings',
  log: 'Log',
};

const STATUS = {
  NEW: 'New',                 // has a website, email not looked up yet
  READY: 'Ready',             // has an email, first email not sent yet
  NO_EMAIL: 'No email',
  CONTACTED: 'Contacted',     // in the sequence
  REPLIED: 'Replied',
  BOOKED: 'Booked',           // set by you
  FINISHED: 'Finished',       // whole sequence sent, no reply
  BOUNCED: 'Bounced',
  UNSUBSCRIBED: 'Unsubscribed',
  DNC: 'Do not contact',      // set by you, or a duplicate email
};

const LEAD_COLUMNS = [
  'ID', 'Company', 'First name', 'Email', 'Status', 'Step', 'Last sent', 'Next send',
  'Opens', 'Last opened', 'Replied at', 'Website', 'Phone', 'City', 'Address', 'Source',
  'Notes', 'Added', 'Subject', 'Thread ID', 'Message ID', 'Place ID',
];

const SETTINGS = [
  ['Your name', '', 'Signs every email. Required.'],
  ['Postal address', '', 'Required by US anti-spam law (CAN-SPAM). A PO box or virtual mailbox is fine.'],
  ['Booking link', 'https://calendly.com/turnoverdesk', 'Used as {{bookingLink}}. Each lead gets utm_content=<lead ID> so Calendly shows who booked.'],
  ['Website', 'https://turnoverdesk.com', 'Used as {{website}}.'],
  ['Daily send limit', 20, 'First emails plus follow-ups per day. Start at 20 and raise slowly; Gmail suspends accounts that blast.'],
  ['Send on weekends', false, ''],
  ['Max searches per day', 3, 'Each search is up to 3 Google Places requests (60 results), or one free OpenStreetMap search.'],
  ['Free search keywords', 'vacation rental, vacation home, short term rental, vacation property, property management, stays, bnb, airbnb, co-host, cohost, getaways, cabin rentals',
    'Comma-separated. The free OpenStreetMap search keeps businesses whose name contains one of these.'],
  ['Re-run searches after days', 30, ''],
  ['Skip companies containing', 'Vacasa, Evolve, AvantStay, Sonder, Airbnb, Vrbo, Marriott, Hilton, Hyatt, Hotel, Motel', 'Comma-separated. Big chains will not buy this.'],
  ['Web app URL', '', 'Optional. Paste the /exec URL from Deploy → Web app to turn on one-click unsubscribe and open tracking.'],
  ['Track opens', true, 'Only works with a Web app URL. Approximate: Apple Mail and Gmail pre-load images.'],
];

const DEFAULT_TEMPLATES = [
  [1, 0, 'Turnovers at {{company}}',
    'Hi {{firstName}},\n\n' +
    'When a cleaner no-shows or misses something at one of your rentals, who catches it before the next guest walks in?\n\n' +
    "That's what we do at Turnover Desk. We confirm your cleaner the night before, check every turnover photo against the standard you approve, and get anything missed fixed before check-in. If a guest damaged something, you get a timestamped claim packet ready for Airbnb or Vrbo.\n\n" +
    'You keep your cleaners and the tools you already use, like Hostaway, Guesty, Turno or Breezeway.\n\n' +
    'Would a free pilot on one of your units be worth a 15-minute call? {{bookingLink}}\n\n' +
    '{{yourName}}\nTurnover Desk | {{website}}'],
  [2, 3, '(follow-ups reply in the same thread)',
    'Hi {{firstName}},\n\n' +
    "Following up in case this got buried. After each turnover you'd get one short report: \"Ready\", or what we found and what we already fixed with your cleaner.\n\n" +
    'Happy to run it free on one unit so you can judge the reports yourself: {{bookingLink}}\n\n' +
    '{{yourName}}'],
  [3, 5, '(follow-ups reply in the same thread)',
    'Hi {{firstName}},\n\n' +
    "I'll stop here so I'm not cluttering your inbox. If missed cleans or cleaner no-shows ever become a headache, just reply to this email and we'll set up a free pilot.\n\n" +
    '{{yourName}}\nTurnover Desk'],
];

// [Google Maps query (used only with a Places API key), area for the free OpenStreetMap search]
const DEFAULT_SEARCHES = [
  ['vacation rental management company Austin TX', 'Austin, TX'],
  ['Airbnb property management Nashville TN', 'Nashville, TN'],
  ['short term rental management Scottsdale AZ', 'Scottsdale, AZ'],
  ['vacation rental management Gatlinburg TN', 'Sevier County, TN'],
  ['Airbnb management company Orlando FL', 'Orange County, FL'],
  ['short term rental co-host Denver CO', 'Denver, CO'],
];

const GMAIL_LABEL = 'Turnover Desk leads';
const RUN_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script stops runs at 6 minutes

// ---------------------------------------------------------------------------
// Menu and setup

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Lead outreach')
    .addItem('Set up sheet', 'setup')
    .addItem('Set Google Places API key (optional)', 'setPlacesKey')
    .addSeparator()
    .addItem('Find leads now', 'findLeadsNow')
    .addItem('Send test emails to me', 'sendTestToMe')
    .addItem('Send due emails now', 'sendNow')
    .addItem('Check replies now', 'checkRepliesNow')
    .addSeparator()
    .addItem('Turn automation on', 'turnOn')
    .addItem('Turn automation off', 'turnOff')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();

  const leads = ensureSheet_(SHEETS.leads, LEAD_COLUMNS);
  const statusCol = LEAD_COLUMNS.indexOf('Status') + 1;
  leads.getRange(2, statusCol, leads.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(Object.values(STATUS), true).setAllowInvalid(false).build());

  const searches = ensureSheet_(SHEETS.searches, ['Query', 'Area', 'Active', 'Last run', 'Leads found']);
  if (searches.getLastRow() === 1) {
    searches.getRange(2, 3, 50, 1).insertCheckboxes();
    searches.getRange(2, 1, DEFAULT_SEARCHES.length, 3).setValues(DEFAULT_SEARCHES.map(q => [q[0], q[1], true]));
  }

  const templates = ensureSheet_(SHEETS.templates, ['Step', 'Wait days', 'Subject', 'Body']);
  if (templates.getLastRow() === 1) {
    templates.getRange(2, 1, DEFAULT_TEMPLATES.length, 4).setValues(DEFAULT_TEMPLATES).setWrap(true).setVerticalAlignment('top');
    templates.setColumnWidth(3, 260).setColumnWidth(4, 560);
  }

  const settings = ensureSheet_(SHEETS.settings, ['Setting', 'Value', 'Notes']);
  const have = settings.getRange(1, 1, settings.getLastRow(), 1).getValues().map(r => r[0]);
  const missing = SETTINGS.filter(s => have.indexOf(s[0]) === -1);
  if (missing.length) settings.getRange(settings.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
  settings.setColumnWidth(1, 200).setColumnWidth(2, 320).setColumnWidth(3, 520);

  ensureSheet_(SHEETS.log, ['Time', 'Lead ID', 'Email', 'Event', 'Detail']);
  ensureSheet_(SHEETS.dashboard, []);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', Utilities.getUuid());

  ss.setActiveSheet(ss.getSheetByName(SHEETS.settings));
  updateDashboard_();
  SpreadsheetApp.getUi().alert(
    'Set up done.\n\n1. Fill in "Your name" and "Postal address" here in Settings.\n' +
    '2. Review the Templates and Searches tabs.\n' +
    '3. Lead outreach → Find leads now, then Send test emails to me.\n4. Lead outreach → Turn automation on.\n\n' +
    'Leads come free from OpenStreetMap. A Google Places API key (optional) finds more.');
}

function setPlacesKey() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Google Places API key (optional)',
    'Paste the key from console.cloud.google.com (Places API (New) enabled). Leave it empty and press OK to go back to the free OpenStreetMap search.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = res.getResponseText().trim();
  const props = PropertiesService.getScriptProperties();
  if (key) props.setProperty('PLACES_API_KEY', key); else props.deleteProperty('PLACES_API_KEY');
  ui.alert(key ? 'Saved. Searches now use Google Maps (the Query column).' : 'Removed. Searches use free OpenStreetMap (the Area column).');
}

function turnOn() {
  const problems = settingsProblems_(settings_());
  if (problems.length) return SpreadsheetApp.getUi().alert('Fix these first:\n\n' + problems.join('\n'));
  removeTriggers_();
  ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1).atHour(9).create();
  ScriptApp.newTrigger('hourlyRun').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('Automation is on. Emails go out daily around 9 am (' + Session.getScriptTimeZone() +
    '), and replies are checked every hour.');
}

function turnOff() {
  removeTriggers_();
  SpreadsheetApp.getUi().alert('Automation is off. Nothing will be sent until you turn it on again.');
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['dailyRun', 'hourlyRun'].indexOf(t.getHandlerFunction()) !== -1)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ---------------------------------------------------------------------------
// Scheduled and manual runs

function dailyRun() {
  withLock_(deadline => {
    checkReplies_();
    sendDue_(deadline);
    findLeads_(deadline);
    enrichLeads_(deadline);
    updateDashboard_();
  });
}

function hourlyRun() {
  withLock_(deadline => {
    checkReplies_();
    enrichLeads_(deadline);
    updateDashboard_();
  });
}

function findLeadsNow() {
  withLock_(deadline => {
    const added = findLeads_(deadline, true);
    const found = enrichLeads_(deadline);
    updateDashboard_();
    toast_(added + ' new leads, ' + found + ' emails found. See the Leads tab.');
  });
}

function sendNow() {
  withLock_(deadline => {
    checkReplies_();
    const sent = sendDue_(deadline);
    updateDashboard_();
    toast_(sent + ' emails sent.');
  });
}

function checkRepliesNow() {
  withLock_(() => {
    const changed = checkReplies_();
    updateDashboard_();
    toast_(changed + ' leads updated.');
  });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    fn(Date.now() + RUN_BUDGET_MS);
  } catch (e) {
    log_('', '', 'Error', e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 1. Find leads: free on OpenStreetMap, or on Google Maps if you add a Places API key

function findLeads_(deadline, ignoreDailyCap) {
  const key = PropertiesService.getScriptProperties().getProperty('PLACES_API_KEY');
  const s = settings_();
  const skip = String(s['Skip companies containing'] || '').split(',').map(w => w.trim().toLowerCase()).filter(String);
  const maxSearches = Number(s['Max searches per day']) || 3;
  const rerunDays = Number(s['Re-run searches after days']) || 30;

  const searches = table_(SHEETS.searches);
  const leads = table_(SHEETS.leads);
  const seen = new Set();
  leads.rows.forEach(r => {
    if (r['Place ID']) seen.add('p:' + r['Place ID']);
    if (domain_(r.Website)) seen.add('d:' + domain_(r.Website));
  });

  const fresh = [];
  let runs = 0;
  for (const q of searches.rows) {
    if (Date.now() > deadline || (!ignoreDailyCap && runs >= maxSearches)) break;
    if (!truthy_(q.Active)) continue;
    if (key ? !q.Query : !q.Area) continue;
    if (q['Last run'] && daysSince_(q['Last run']) < rerunDays) continue;
    runs++;

    const label = key ? q.Query : 'OpenStreetMap: ' + q.Area;
    let found;
    try {
      found = key ? searchPlaces_(q.Query, key) : searchOsm_(q.Area, s['Free search keywords']);
    } catch (e) {
      log_('', '', 'Error', 'Search "' + label + '": ' + e.message);
      continue;
    }

    let added = 0;
    for (const p of found) {
      const d = domain_(p.website);
      if (seen.has('p:' + p.id) || (d && seen.has('d:' + d))) continue;
      if (skip.some(w => p.name.toLowerCase().indexOf(w) !== -1 || (d && d.indexOf(w.replace(/\s+/g, '')) !== -1))) continue;
      seen.add('p:' + p.id);
      if (d) seen.add('d:' + d);
      fresh.push({
        ID: newId_(), Company: p.name, Email: p.email || '', Website: p.website || '', Phone: p.phone || '',
        City: p.city, Address: p.address, Status: p.website || p.email ? STATUS.NEW : STATUS.NO_EMAIL,
        Step: 0, Opens: 0, Source: label, 'Place ID': p.id, Added: new Date(),
      });
      added++;
    }
    q['Last run'] = new Date();
    q['Leads found'] = (Number(q['Leads found']) || 0) + added;
    searches.save(q);
    log_('', '', 'Search', '"' + label + '": ' + found.length + ' results, ' + added + ' new');
  }
  leads.append(fresh);
  return fresh.length;
}

// Free, no key: finds businesses in an area whose name matches the keywords.
// OpenStreetMap is volunteer-mapped, so it lists fewer companies than Google Maps.
function searchOsm_(area, keywords) {
  const geo = UrlFetchApp.fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
    encodeURIComponent(area) + '&email=' + encodeURIComponent(myAddresses_().primary), { muteHttpExceptions: true });
  if (geo.getResponseCode() !== 200) throw new Error('Could not look up the area (' + geo.getResponseCode() + ')');
  const place = JSON.parse(geo.getContentText())[0];
  if (!place) throw new Error('Area not found. Try "City, ST", for example "Austin, TX".');
  const b = place.boundingbox.map(Number); // south, north, west, east
  const bbox = [b[0], b[2], b[1], b[3]].join(',');

  const words = String(keywords || '').split(',').map(w => w.trim()).filter(String)
    .map(w => w.replace(/[\\"]/g, '').replace(/[.*+?^${}()|[\]]/g, '\\\\$&'));
  if (!words.length) throw new Error('Settings: "Free search keywords" is empty.');
  const name = '["name"~"' + words.join('|') + '",i]';
  const query = '[out:json][timeout:90];(' +
    ['website', 'contact:website', 'email', 'contact:email']
      .map(tag => 'nwr' + name + '["' + tag + '"]["tourism"!~"hotel|motel|hostel"](' + bbox + ');').join('') +
    ');out center tags;';

  const res = UrlFetchApp.fetch('https://overpass-api.de/api/interpreter', {
    method: 'post', payload: { data: query }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('OpenStreetMap search failed (' + res.getResponseCode() + '). It is often busy; the next run retries.');
  return (JSON.parse(res.getContentText()).elements || []).map(el => {
    const t = el.tags || {};
    const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
    const city = [t['addr:city'], t['addr:state']].filter(Boolean).join(', ') || area;
    return {
      id: 'osm:' + el.type + '/' + el.id,
      name: t.name || '',
      website: t.website || t['contact:website'] || t.url || '',
      email: String(t.email || t['contact:email'] || '').split(/[;,\s]/)[0].toLowerCase(),
      phone: t.phone || t['contact:phone'] || '',
      city: city,
      address: [street, city, t['addr:postcode']].filter(Boolean).join(', '),
    };
  });
}

function searchPlaces_(query, key) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 3; page++) {
    const body = { textQuery: query, pageSize: 20 };
    if (pageToken) body.pageToken = pageToken;
    const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.addressComponents,' +
          'places.websiteUri,places.nationalPhoneNumber,places.businessStatus,nextPageToken',
      },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('Places API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    }
    const data = JSON.parse(res.getContentText());
    (data.places || []).forEach(p => {
      if (p.businessStatus === 'CLOSED_PERMANENTLY') return;
      out.push({
        id: p.id, name: (p.displayName && p.displayName.text) || '', website: p.websiteUri || '', email: '',
        phone: p.nationalPhoneNumber || '', city: city_(p), address: p.formattedAddress || '',
      });
    });
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

function city_(place) {
  const parts = place.addressComponents || [];
  const get = type => {
    const c = parts.find(a => (a.types || []).indexOf(type) !== -1);
    return c ? c.shortText : '';
  };
  return [get('locality'), get('administrative_area_level_1')].filter(String).join(', ');
}

// ---------------------------------------------------------------------------
// 2. Find an email on each lead's website

function enrichLeads_(deadline) {
  const leads = table_(SHEETS.leads);
  const taken = new Set(leads.rows.map(r => String(r.Email || '').trim().toLowerCase()).filter(String));
  let found = 0;
  for (const r of leads.rows) {
    if (Date.now() > deadline) break;

    // Rows you typed in by hand: give them an ID and a status.
    if (!r.ID && (r.Email || r.Website || r.Company)) {
      Object.assign(r, { ID: newId_(), Step: 0, Opens: 0, Added: new Date(), Source: r.Source || 'Added by hand' });
      if (!r.Status) r.Status = r.Email ? STATUS.READY : r.Website ? STATUS.NEW : STATUS.NO_EMAIL;
      leads.save(r);
    }
    if (r.Status !== STATUS.NEW) continue;

    if (r.Email) {
      r.Status = STATUS.READY;
    } else {
      const email = findEmail_(r.Website);
      if (email && !taken.has(email)) {
        r.Email = email;
        r.Status = STATUS.READY;
        taken.add(email);
        found++;
      } else {
        r.Status = STATUS.NO_EMAIL;
        if (email) r.Notes = appendNote_(r.Notes, 'Same email as another lead: ' + email);
      }
    }
    leads.save(r);
  }
  return found;
}

function findEmail_(website) {
  const m = String(website || '').trim().match(/^(https?:\/\/[^\/?#]+)/i);
  if (!m) return '';
  const site = domain_(website);
  const found = [];
  for (const url of [website, m[1] + '/contact', m[1] + '/contact-us', m[1] + '/about']) {
    let html;
    try {
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() >= 400) continue;
      html = res.getContentText();
    } catch (e) {
      continue;
    }
    extractEmails_(html).forEach(e => { if (found.indexOf(e) === -1) found.push(e); });
    const best = pickEmail_(found, site);
    if (best && emailDomain_(best) === site) return best;
  }
  return pickEmail_(found, site);
}

function extractEmails_(html) {
  const text = String(html)
    .replace(/\\u003[ce]/gi, ' ')
    .replace(/&#0*64;|&#x0*40;|%40/gi, '@')
    .replace(/\s*\[at\]\s*/gi, '@');
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return matches.map(e => e.toLowerCase().replace(/^[._%+-]+/, '').replace(/\.+$/, '')).filter(isUsableEmail_);
}

function isUsableEmail_(e) {
  if (e.length > 80) return false;
  if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e)) return false;
  if (/^(no-?reply|do-?not-?reply|privacy|abuse|postmaster|webmaster|example|email|name|your|user|test)@/.test(e)) return false;
  if (/@(example\.|domain\.|email\.com$|yourdomain|test\.|sentry|.*wixpress\.com$|godaddy\.com$|squarespace\.com$|wix\.com$)/.test(e)) return false;
  return true;
}

// Prefer an address on the company's own domain.
function pickEmail_(emails, site) {
  return emails.find(e => emailDomain_(e) === site) || emails[0] || '';
}

// ---------------------------------------------------------------------------
// 3. Send the sequence

function sendDue_(deadline) {
  const s = settings_();
  const problems = settingsProblems_(s);
  if (problems.length) {
    log_('', '', 'Not sent', problems.join(' '));
    return 0;
  }
  const day = new Date().getDay();
  if (!truthy_(s['Send on weekends']) && (day === 0 || day === 6)) return 0;

  const steps = templates_();
  const leads = table_(SHEETS.leads);
  const me = myAddresses_();
  const now = new Date();
  let budget = (Number(s['Daily send limit']) || 20) - leads.rows.filter(r => isToday_(r['Last sent'])).length;

  const emailed = new Set(leads.rows
    .filter(r => Number(r.Step) > 0 || [STATUS.UNSUBSCRIBED, STATUS.BOUNCED, STATUS.DNC].indexOf(r.Status) !== -1)
    .map(r => String(r.Email).trim().toLowerCase()));

  const followUps = leads.rows.filter(r => r.Status === STATUS.CONTACTED && r['Next send'] && new Date(r['Next send']) <= now);
  const firsts = leads.rows.filter(r => r.Status === STATUS.READY && r.Email);
  let sent = 0;

  for (const r of followUps.concat(firsts)) {
    if (budget <= 0 || Date.now() > deadline) break;
    const step = Number(r.Step) || 0;

    if (step >= steps.length) {
      r.Status = STATUS.FINISHED;
      r['Next send'] = '';
      leads.save(r);
      continue;
    }
    if (step > 0 && refreshLead_(r, me)) { // replied or bounced since the last check
      leads.save(r);
      continue;
    }
    const email = String(r.Email).trim().toLowerCase();
    if (step === 0 && emailed.has(email)) {
      r.Status = STATUS.DNC;
      r.Notes = appendNote_(r.Notes, 'Duplicate of a lead already emailed');
      leads.save(r);
      continue;
    }

    try {
      sendStep_(r, steps[step], s, me);
    } catch (e) {
      log_(r.ID, r.Email, 'Error', 'Email ' + (step + 1) + ': ' + e.message);
      continue;
    }
    emailed.add(email);
    budget--;
    sent++;
    r.Step = step + 1;
    r.Status = STATUS.CONTACTED;
    r['Last sent'] = new Date();
    // After the last email, wait a week for a reply before marking it Finished.
    r['Next send'] = startOfDay_(addDays_(new Date(), steps[step + 1] ? steps[step + 1].wait : 7));
    leads.save(r);
    Utilities.sleep(1500);
  }
  return sent;
}

function sendStep_(r, tpl, s, me) {
  const vars = vars_(r, s);
  const followUp = Number(r.Step) > 0 && r['Thread ID'];
  const subject = followUp ? 'Re: ' + String(r.Subject).replace(/^re:\s*/i, '') : fill_(tpl.subject, vars);
  const body = fill_(tpl.body, vars);
  const links = trackingLinks_(r, s);
  const footer = String(s['Postal address']).trim();
  const optOut = links.unsubscribe
    ? "Don't want these emails? Unsubscribe: " + links.unsubscribe
    : "Don't want these emails? Reply \"unsubscribe\" and we won't write again.";

  const text = body + '\n\n--\n' + footer + '\n' + optOut;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f2421">' +
    textToHtml_(body) +
    '<p style="margin-top:24px;font-size:12px;color:#8a918d">' + escapeHtml_(footer) + '<br>' +
    (links.unsubscribe
      ? 'Don\'t want these emails? <a href="' + escapeHtml_(links.unsubscribe) + '" style="color:#8a918d">Unsubscribe</a>'
      : escapeHtml_(optOut)) +
    '</p>' +
    (links.pixel ? '<img src="' + escapeHtml_(links.pixel) + '" width="1" height="1" alt="">' : '') +
    '</div>';

  const unsubHeader = ['<mailto:' + me.primary + '?subject=unsubscribe>'];
  if (links.unsubscribe) unsubHeader.unshift('<' + links.unsubscribe + '>');

  const mime = buildMime_({
    fromName: s['Your name'] + ' | Turnover Desk', from: me.primary, to: String(r.Email).trim(), subject, text, html,
    inReplyTo: followUp ? r['Message ID'] : '', listUnsubscribe: unsubHeader.join(', '), oneClick: !!links.unsubscribe,
  });

  const resource = { raw: Utilities.base64EncodeWebSafe(mime) };
  if (followUp) resource.threadId = r['Thread ID'];
  const sent = Gmail.Users.Messages.send(resource, 'me');

  if (!followUp) {
    const meta = Gmail.Users.Messages.get('me', sent.id, { format: 'metadata', metadataHeaders: ['Message-ID'] });
    const header = ((meta.payload && meta.payload.headers) || []).find(h => /^message-id$/i.test(h.name));
    r['Message ID'] = header ? header.value : '';
    r['Thread ID'] = sent.threadId;
    r.Subject = subject;
  }
  try {
    const label = GmailApp.getUserLabelByName(GMAIL_LABEL) || GmailApp.createLabel(GMAIL_LABEL);
    GmailApp.getThreadById(sent.threadId).addLabel(label);
  } catch (e) { /* the label is a convenience */ }

  log_(r.ID, r.Email, 'Sent', 'Email ' + (Number(r.Step) + 1) + ': ' + subject);
}

function sendTestToMe() {
  const s = settings_();
  const problems = settingsProblems_(s);
  if (problems.length) return SpreadsheetApp.getUi().alert('Fix these first:\n\n' + problems.join('\n'));
  const leads = table_(SHEETS.leads).rows;
  const sample = leads.find(r => r.Status === STATUS.READY) || leads.find(r => r.Email) ||
    { ID: 'TEST', Company: 'Sample Rentals', 'First name': '', City: 'Austin, TX' };
  const me = myAddresses_().primary;
  const steps = templates_();
  steps.forEach((tpl, i) => {
    const vars = vars_(sample, s);
    const subject = '[Test ' + (i + 1) + '/' + steps.length + ', ' + (sample.Email || 'sample lead') + '] ' +
      (i === 0 ? fill_(tpl.subject, vars) : 'follow-up after ' + tpl.wait + ' days');
    const body = fill_(tpl.body, vars) + '\n\n--\n' + s['Postal address'];
    GmailApp.sendEmail(me, subject, body, { htmlBody: textToHtml_(body), name: s['Your name'] + ' | Turnover Desk' });
  });
  SpreadsheetApp.getUi().alert('Sent ' + steps.length + ' test emails to ' + me + ', written for ' + (sample.Company || 'a sample lead') + '.');
}

function templates_() {
  return table_(SHEETS.templates).rows
    .filter(t => String(t.Body).trim())
    .sort((a, b) => Number(a.Step) - Number(b.Step))
    .map(t => ({ wait: Number(t['Wait days']) || 0, subject: String(t.Subject), body: String(t.Body) }));
}

function vars_(r, s) {
  const link = String(s['Booking link'] || '').trim();
  return {
    firstName: String(r['First name'] || '').trim() || 'there',
    company: String(r.Company || '').trim() || 'your rentals',
    city: String(r.City || '').split(',')[0].trim() || 'your area',
    yourName: s['Your name'],
    website: s.Website,
    bookingLink: link ? link + (link.indexOf('?') === -1 ? '?' : '&') + 'utm_source=outreach&utm_content=' + r.ID : '',
  };
}

function fill_(template, vars) {
  return String(template).replace(/{{\s*(\w+)\s*}}/g, (m, k) => (vars[k] === undefined ? '' : String(vars[k])));
}

function trackingLinks_(r, s) {
  const base = String(s['Web app URL'] || '').trim();
  if (!base) return {};
  const q = 'id=' + encodeURIComponent(r.ID) + '&t=' + token_(r.ID);
  return {
    unsubscribe: base + '?a=u&' + q,
    pixel: truthy_(s['Track opens']) ? base + '?a=o&' + q + '&n=' + (Number(r.Step) + 1) : '',
  };
}

function buildMime_(m) {
  const boundary = 'td' + Utilities.getUuid().replace(/-/g, '');
  const word = s => '=?UTF-8?B?' + Utilities.base64Encode(s, Utilities.Charset.UTF_8) + '?=';
  const b64 = s => Utilities.base64Encode(s, Utilities.Charset.UTF_8).replace(/.{76}/g, '$&\r\n');
  const headers = [
    'MIME-Version: 1.0',
    'From: ' + word(m.fromName) + ' <' + m.from + '>',
    'To: ' + m.to,
    'Subject: ' + word(m.subject),
  ];
  if (m.inReplyTo) headers.push('In-Reply-To: ' + m.inReplyTo, 'References: ' + m.inReplyTo);
  if (m.listUnsubscribe) headers.push('List-Unsubscribe: ' + m.listUnsubscribe);
  if (m.oneClick) headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  headers.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
  return headers.join('\r\n') + '\r\n\r\n' +
    '--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64(m.text) + '\r\n' +
    '--' + boundary + '\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64(m.html) + '\r\n' +
    '--' + boundary + '--';
}

function textToHtml_(text) {
  return String(text).trim().split(/\n{2,}/).map(p =>
    '<p style="margin:0 0 14px">' +
    escapeHtml_(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0F6E56">$1</a>') +
    '</p>').join('');
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// 4. Track replies, bounces, unsubscribes and opens

function checkReplies_() {
  const leads = table_(SHEETS.leads);
  const me = myAddresses_();
  let changed = 0;
  for (const r of leads.rows) {
    if (r.Status === STATUS.CONTACTED && r['Thread ID'] && refreshLead_(r, me)) {
      leads.save(r);
      changed++;
    }
  }
  return changed + checkBounces_(leads);
}

// Reads the lead's Gmail thread. Returns true if the lead left the sequence.
function refreshLead_(r, me) {
  let thread;
  try {
    thread = GmailApp.getThreadById(r['Thread ID']);
  } catch (e) {
    return false;
  }
  if (!thread) return false;
  for (const msg of thread.getMessages()) {
    const from = address_(msg.getFrom());
    if (me.all.has(from)) continue;
    const subject = msg.getSubject();
    if (/mailer-daemon|postmaster/i.test(from) || /delivery status notification|undeliverable|delivery has failed/i.test(subject)) {
      return leaveSequence_(r, STATUS.BOUNCED, subject);
    }
    if (/automatic reply|auto[- ]?reply|out of (the )?office|^auto:/i.test(subject)) continue;
    const newText = msg.getPlainBody().split(/\n(?:On .{0,200}wrote:|>|-{2,} ?Original Message)/i)[0].slice(0, 1000);
    if (/\b(unsubscribe|remove me|take me off|stop emailing|do not (contact|email))\b/i.test(newText)) {
      return leaveSequence_(r, STATUS.UNSUBSCRIBED, 'Asked by reply');
    }
    r['Replied at'] = msg.getDate();
    return leaveSequence_(r, STATUS.REPLIED, newText.trim().replace(/\s+/g, ' ').slice(0, 200));
  }
  return false;
}

// Gmail does not always thread bounce notices, so also scan recent ones.
function checkBounces_(leads) {
  const contacted = {};
  leads.rows.forEach(r => { if (r.Status === STATUS.CONTACTED && r.Email) contacted[String(r.Email).trim().toLowerCase()] = r; });
  const emails = Object.keys(contacted);
  if (!emails.length) return 0;
  let changed = 0;
  GmailApp.search('from:(mailer-daemon OR postmaster) newer_than:3d', 0, 50).forEach(t => t.getMessages().forEach(m => {
    const haystack = ((m.getHeader('X-Failed-Recipients') || '') + '\n' + m.getPlainBody()).toLowerCase();
    emails.forEach(e => {
      const r = contacted[e];
      if (r.Status === STATUS.CONTACTED && haystack.indexOf(e) !== -1) {
        leaveSequence_(r, STATUS.BOUNCED, m.getSubject());
        leads.save(r);
        changed++;
      }
    });
  }));
  return changed;
}

function leaveSequence_(r, status, detail) {
  r.Status = status;
  r['Next send'] = '';
  log_(r.ID, r.Email, status, detail || '');
  return true;
}

// Web app: one-click unsubscribe and the open-tracking pixel.
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.id || p.t !== token_(p.id)) return ContentService.createTextOutput('');
  if (p.a === 'o') {
    recordOpen_(p.id);
    return ContentService.createTextOutput('');
  }
  if (p.a === 'u') {
    unsubscribe_(p.id);
    return HtmlService.createHtmlOutput(
      '<div style="font-family:Arial,sans-serif;max-width:420px;margin:80px auto;text-align:center;color:#1f2421">' +
      '<h2>You\'re unsubscribed</h2><p>Turnover Desk won\'t email you again.</p></div>').setTitle('Unsubscribed');
  }
  return ContentService.createTextOutput('');
}

// Mail apps that support one-click unsubscribe POST to the same URL.
function doPost(e) {
  const p = (e && e.parameter) || {};
  if (p.id && p.t === token_(p.id) && p.a === 'u') unsubscribe_(p.id);
  return ContentService.createTextOutput('');
}

function unsubscribe_(id) {
  updateLeadById_(id, (r, leads) => {
    if (r.Status === STATUS.UNSUBSCRIBED) return;
    leaveSequence_(r, STATUS.UNSUBSCRIBED, 'Unsubscribe link');
    leads.save(r);
  });
}

function recordOpen_(id) {
  updateLeadById_(id, (r, leads) => {
    r.Opens = (Number(r.Opens) || 0) + 1;
    r['Last opened'] = new Date();
    leads.save(r);
    if (r.Opens === 1) log_(r.ID, r.Email, 'Opened', '');
  });
}

function updateLeadById_(id, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20 * 1000)) return;
  try {
    const leads = table_(SHEETS.leads);
    const r = leads.rows.find(x => String(x.ID) === String(id));
    if (r) fn(r, leads);
  } finally {
    lock.releaseLock();
  }
}

function token_(id) {
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET') || '';
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(id), secret)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Dashboard

function updateDashboard_() {
  const sheet = ensureSheet_(SHEETS.dashboard, []);
  const rows = table_(SHEETS.leads).rows.filter(r => r.ID);
  const count = st => rows.filter(r => r.Status === st).length;
  const emailed = rows.filter(r => Number(r.Step) > 0);
  const replied = count(STATUS.REPLIED) + count(STATUS.BOOKED);
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 + '%' : '–');
  const weekAgo = addDays_(new Date(), -7);
  const due = rows.filter(r => r.Status === STATUS.CONTACTED && r['Next send'] && new Date(r['Next send']) <= addDays_(new Date(), 1)).length;

  const out = [
    ['Turnover Desk outreach', ''],
    ['Updated', new Date()],
    ['', ''],
    ['Pipeline', ''],
    ['Leads found', rows.length],
    ['With an email', rows.filter(r => r.Email).length],
    ['Waiting for first email (Ready)', count(STATUS.READY)],
    ['In sequence (Contacted)', count(STATUS.CONTACTED)],
    ['Follow-ups due by tomorrow', due],
    ['', ''],
    ['Results', ''],
    ['Leads emailed', emailed.length],
    ['Emails sent', emailed.reduce((n, r) => n + Number(r.Step), 0)],
    ['Emailed in the last 7 days', rows.filter(r => r['Last sent'] && new Date(r['Last sent']) >= weekAgo).length],
    ['Opened (approximate)', rows.filter(r => Number(r.Opens) > 0).length],
    ['Replied', replied],
    ['Reply rate', pct(replied, emailed.length)],
    ['Booked', count(STATUS.BOOKED)],
    ['Finished, no reply', count(STATUS.FINISHED)],
    ['Bounced', count(STATUS.BOUNCED)],
    ['Bounce rate', pct(count(STATUS.BOUNCED), emailed.length)],
    ['Unsubscribed', count(STATUS.UNSUBSCRIBED)],
    ['No email found', count(STATUS.NO_EMAIL)],
  ];
  sheet.clear();
  sheet.getRange(1, 1, out.length, 2).setValues(out);
  sheet.getRange('A1').setFontSize(16).setFontWeight('bold');
  sheet.getRange('A4').setFontWeight('bold');
  sheet.getRange('A11').setFontWeight('bold');
  sheet.getRange('B2').setNumberFormat('ddd d mmm, h:mm am/pm');
  sheet.getRange(2, 2, out.length - 1, 1).setHorizontalAlignment('right');
  sheet.setColumnWidth(1, 260).setColumnWidth(2, 160);
}

// ---------------------------------------------------------------------------
// Helpers

function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (!headers.length) return sheet;
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const have = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const missing = headers.filter(h => have.indexOf(h) === -1);
    if (missing.length) sheet.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
  }
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

// Reads a tab into objects keyed by header, so columns can be reordered freely.
function table_(name) {
  const sheet = ensureSheet_(name, []);
  const values = sheet.getDataRange().getValues();
  const headers = (values.shift() || []).map(String);
  const rows = values.map((v, i) => {
    const o = { _row: i + 2 };
    headers.forEach((h, j) => { o[h] = v[j]; });
    return o;
  });
  const toRow = o => headers.map(h => (o[h] === undefined || o[h] === null ? '' : o[h]));
  return {
    rows,
    save(o) {
      sheet.getRange(o._row, 1, 1, headers.length).setValues([toRow(o)]);
    },
    append(objs) {
      if (!objs.length) return;
      const extra = sheet.getLastRow() + objs.length - sheet.getMaxRows();
      if (extra > 0) sheet.insertRowsAfter(sheet.getMaxRows(), extra);
      sheet.getRange(sheet.getLastRow() + 1, 1, objs.length, headers.length).setValues(objs.map(toRow));
    },
  };
}

function settings_() {
  const out = {};
  SETTINGS.forEach(s => { out[s[0]] = s[1]; });
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.settings);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(r => { if (r[0]) out[r[0]] = r[1]; });
  }
  return out;
}

function settingsProblems_(s) {
  const problems = [];
  if (!String(s['Your name']).trim()) problems.push('Settings: fill in "Your name".');
  if (!String(s['Postal address']).trim()) problems.push('Settings: fill in "Postal address" (required by law in commercial email).');
  if (!templates_().length) problems.push('Templates: add at least one email.');
  return problems;
}

function myAddresses_() {
  const primary = Session.getEffectiveUser().getEmail().toLowerCase();
  const all = new Set([primary].concat(GmailApp.getAliases().map(a => a.toLowerCase())));
  return { primary, all };
}

function log_(id, email, event, detail) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.log);
  if (sheet) sheet.appendRow([new Date(), id, email, event, detail]);
}

function toast_(msg) {
  SpreadsheetApp.getActive().toast(msg, 'Lead outreach', 8);
}

function address_(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim().toLowerCase();
}

function domain_(url) {
  const m = String(url || '').trim().toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?([^\/?#:]+)/);
  return m && m[1].indexOf('.') !== -1 ? m[1] : '';
}

function emailDomain_(email) {
  return String(email).split('@')[1].replace(/^www\./, '');
}

function newId_() {
  return 'L' + Utilities.getUuid().replace(/-/g, '').slice(0, 7).toUpperCase();
}

function appendNote_(notes, text) {
  return notes ? notes + ' | ' + text : text;
}

function truthy_(v) {
  return v === true || /^(true|yes|y|1|on)$/i.test(String(v).trim());
}

function addDays_(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfDay_(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysSince_(date) {
  return (Date.now() - new Date(date).getTime()) / 86400000;
}

function isToday_(date) {
  return date instanceof Date && date.toDateString() === new Date().toDateString();
}
