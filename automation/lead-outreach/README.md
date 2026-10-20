# Turnover Desk lead outreach

A Google Sheet that runs your outbound email on its own:

1. **Finds leads.** It searches for short-term rental managers and co-hosts in the markets you list. The search is free and needs no key or card: it uses OpenStreetMap. If you add a Google Places API key, it searches Google Maps instead, which finds more companies but requires a card on file with Google.
2. **Finds their email.** It reads each company's website (home, /contact, /contact-us, /about) and keeps one address, preferring one on the company's own domain.
3. **Sends a 3-email sequence** from your Gmail on weekdays, within a daily limit. Follow-ups reply in the same thread.
4. **Tracks everything** in the sheet. A reply, bounce or unsubscribe takes the lead out of the sequence on its own. Opens are tracked if you set that up, and the Dashboard tab shows the numbers.

It runs on Google's servers, so your computer doesn't need to be on. It isn't deployed with the website: Cloudflare only serves `public/`.

## Tabs

| Tab | What it's for |
|---|---|
| **Dashboard** | Leads found, emailed, replied, reply rate, bounces, unsubscribes |
| **Leads** | One row per company. You can also add rows by hand: an email alone is enough. |
| **Searches** | One row per market. **Area** (e.g. `Austin, TX`) is used by the free OpenStreetMap search. **Query** (e.g. `Airbnb property management Nashville TN`) is used only once you add a Google Places key. Untick **Active** to pause a row. Each search re-runs every 30 days and skips leads you already have. |
| **Templates** | The emails. Placeholders: `{{firstName}}` `{{company}}` `{{city}}` `{{bookingLink}}` `{{yourName}}` `{{website}}`. **Wait days** is the number of days after the previous email. |
| **Conversations** | New Reddit posts from hosts that mention cleaners, no-shows, missed cleans or damage. Read the post and reply yourself if you can help, then set **Status** to `Replied` or `Not relevant`. Nothing is posted for you. |
| **Settings** | Your name, postal address, daily limit and the rest |
| **Log** | Every search, send, reply, bounce and error |

### Lead statuses

`New` → `Ready` (email found) → `Contacted` (in the sequence) → `Replied` / `Finished` (no reply a week after the last email) / `Bounced` / `Unsubscribed`.
`No email` means none was found on the website. Add one by hand and set the status back to `New`.
Set **Booked** or **Do not contact** yourself. The script never emails those rows.

When a lead replies, you answer them yourself in Gmail. Every outreach thread has the **Turnover Desk leads** label.
To add a first name, type it in **First name**. Without one, emails start with "Hi there".

## Set up (about 20 minutes)

### 1. Make the sheet
1. Sign in to Google as **turnoverdesk@gmail.com** (emails are sent from the account that owns the script).
2. Create a blank Google Sheet called `Turnover Desk Leads`.
3. Go to **Extensions → Apps Script**.
4. Replace everything in `Code.gs` with this folder's [`Code.gs`](Code.gs).
5. Go to **Project Settings** (gear icon), tick **Show "appsscript.json" manifest file in editor**, then go back to the editor and replace `appsscript.json` with this folder's [`appsscript.json`](appsscript.json).
   This turns on the Gmail API, which threads the follow-ups. To change the time zone, set `timeZone` (for example `America/New_York`).
6. Save. Go back to the sheet and reload it. A **Lead outreach** menu appears.
7. Click **Lead outreach → Set up sheet** and approve the permissions. Google warns "unverified app" because the script is yours. Click **Advanced → Go to project**.

### 2. Optional: find more leads with Google Maps
The free search uses OpenStreetMap. Volunteers map it, so it lists fewer rental companies than Google Maps, maybe a handful to a few dozen per city. You can also paste leads in by hand: an email in the **Email** column is enough.

When you want more leads, add a Google Places API key. It needs a card on file with Google; light use usually stays within the monthly free allowance.
1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project.
2. Turn on billing, then enable **Places API (New)** under **APIs & Services → Library**.
3. Go to **APIs & Services → Credentials → Create credentials → API key**. Restrict the key to **Places API (New)**.
4. Go to **Billing → Budgets & alerts** and set a budget, such as $10/month.
5. In the sheet, click **Lead outreach → Set Google Places API key (optional)** and paste the key. To go back to the free search, open the same menu item and save it empty.

### 3. Fill in Settings and check the emails
- **Your name** and **Postal address** are required. US law (CAN-SPAM) requires a postal address where you can receive mail in every sales email sent to US recipients. It doesn't have to be in the US: your office or home address in the Philippines works, and so does a PO box or virtual mailbox.
- Read the **Templates** tab and make the emails sound like you.
- Edit **Searches** to the markets you want. For the free search, write the **Area** like `Austin, TX` or `Sevier County, TN`.

### 4. Try it
1. Click **Lead outreach → Find leads now**. Leads appear in the **Leads** tab within a minute or two.
2. Click **Lead outreach → Send test emails to me**. The whole sequence lands in your own inbox, written for one real lead.

### 5. Optional: one-click unsubscribe and open tracking
1. In Apps Script, click **Deploy → New deployment → Web app**. Set **Execute as: Me** and **Who has access: Anyone**, then deploy.
2. Copy the URL that ends in `/exec` into **Settings → Web app URL**.

Every email then gets an "Unsubscribe" link and the one-click unsubscribe button Gmail and Apple Mail show. Opens are counted in the **Opens** column. Treat opens as a rough signal: Apple Mail pre-loads images, and opening the email in your own Sent folder counts too. Replies are the number that matters.

Without a web app URL, emails say *Reply "unsubscribe"*, and the script catches those replies.

### 6. Turn it on
Click **Lead outreach → Turn automation on**.
- **Every day around 9 am:** checks replies, sends due follow-ups first and then first emails (up to the daily limit), runs new searches, and looks up emails.
- **Every hour:** checks replies and bounces, checks Reddit for the Conversations tab, looks up emails, and refreshes the Dashboard.

To stop everything, click **Lead outreach → Turn automation off**.

## Keep your Gmail healthy
- Start at **20 emails a day** and raise it by about 10 a week while the bounce rate stays under 3%. Free Gmail accounts can't send more than a few hundred a day in total.
- Keep the emails plain and short, with one link. Don't add attachments or images.
- If the bounce rate climbs, lower the daily limit and check the **No email** and **Bounced** rows.
- A Google Workspace address on `@turnoverdesk.com` will reach more inboxes than `@gmail.com`. To switch, run the same script from a sheet owned by that account.

## Rules worth knowing
- **US leads:** CAN-SPAM allows cold B2B email as long as the subject line is honest, the email includes your postal address, there's a working opt-out, and you honor opt-outs right away. The script handles the last three. Don't edit them out.
- **UK:** cold B2B email is allowed to companies (Ltd, LLP and similar) as long as you say who you are and include an opt-out. Sole traders and partnerships count as individuals and need consent first, so skip leads that look like one person's own holiday let.
- **Australia:** the Spam Act allows email to an address a business publishes on its own website when the message relates to that business. Include your details and an opt-out, which the script does.
- **Canada and the EU** have stricter consent rules (CASL, GDPR). Leave them out unless you've checked the rules.
- Emails go out around 9 am US Central time. That's mid-afternoon in the UK and late night in Australia; replies still come in the next morning their time.
- **Google Maps data:** Google's Places terms limit how long you may store place details other than the place ID. Treat the Leads tab as your working outreach list, not a database to resell or keep forever, and delete leads that don't pan out. If you'd rather use a source licensed for lead lists, Apollo or Hunter.io exports can be pasted straight into the Leads tab (an email is enough).
- Don't scrape Airbnb or Vrbo listings, or Facebook. Their terms forbid it.
- **Reddit:** the Conversations tab only reads public posts. Reply as yourself, be helpful first, and follow each community's rules on self-promotion. Don't send unsolicited DMs in bulk.
