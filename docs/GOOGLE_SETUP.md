# Google Calendar setup

The planner writes your study blocks into one dedicated Google Calendar. It never touches your other
calendars.

There are **two ways to connect it, and you only need one.** Both are free and take about ten
minutes.

| | **A · Service account** (recommended) | **B · OAuth** |
|---|---|---|
| Who owns the calendar | **you** | the planner |
| Consent screen | none | yes, once |
| Credential expires | **never** | the refresh token dies after **7 days** while the Cloud app is in Testing mode |
| What the credential can reach | only calendars you shared with it | your account, limited to the `calendar.app.created` scope |
| Organizer shown on events | the service account | you |

**Pick A unless you need your own name on the events.** The 7-day expiry in option B is not a
setting you can turn off: it is how Google treats an app in Testing mode, and leaving Testing needs a
verified domain. Option A has nothing to expire, and the credential it uses can only see the one
calendar you deliberately shared with it — so it is both less work and a tighter grant.

Option A is [section A](#a--service-account-recommended) below. Option B starts at
[section 1](#1-create-a-google-cloud-project); its steps 1 and 2 are shared, so read those either way.

---

## A · Service account (recommended)

### A1. Create the service account

1. Do [section 1](#1-create-a-google-cloud-project) and [section 2](#2-enable-the-google-calendar-api)
   first — you need a project with the Calendar API enabled. Nothing else from option B applies:
   there is no consent screen, no Branding, no test users, no OAuth client.
2. Open **IAM & Admin → Service Accounts**, or go straight to
   <https://console.cloud.google.com/iam-admin/serviceaccounts> with your project selected.
3. Click **Create service account**.
4. **Service account name**: `planner`. The ID fills in by itself. Click **Create and continue**.
5. **"Grant this service account access to project"** — **skip it** and click **Continue**. This is
   the step people get wrong: calendar access does *not* come from an IAM role, it comes from sharing
   the calendar in A3. A role here grants nothing useful and only widens what the key can do.
6. **"Grant users access to this service account"** — skip, click **Done**.

### A2. Download its key

1. Click the service account you just created, then the **Keys** tab.
2. **Add key → Create new key → JSON → Create**. A file downloads.
3. Move it to `.data/google-service-account.json` in the repo. Create `.data/` if it is not there.

> That file is a private key with **no expiry**. Treat it like a password. `.data/` is gitignored, and
> `.gitignore` also matches `*service-account*.json` anywhere in the tree in case a download lands
> somewhere else. Never commit it, never paste it into a chat, and never email it to yourself.

4. Copy the service account's email address, shown on its detail page and in the file as
   `client_email`. It looks like `planner@your-project.iam.gserviceaccount.com`.

### A3. Create the calendar and share it

1. Open <https://calendar.google.com>. Next to **Other calendars** in the left sidebar, click **+**,
   then **Create new calendar**.
2. **Name**: `Study plan`. Set **Time zone** to the zone you actually live in — the same one the
   planner uses (`PLANNER_TZ`, default your system zone). Click **Create new calendar**.
3. Open that calendar's **Settings and sharing**.
4. Under **Share with specific people or groups**, click **Add people and groups**, paste the service
   account email, and set the permission to **Make changes to events**. Not "Make changes *and manage
   sharing*" — the planner never needs to re-share your calendar.
5. Click **Send**. Google may warn that it could not send an invitation to that address. **That is
   expected**: a service account has no inbox. The permission is granted anyway — reload the page and
   you will see it listed.
6. Scroll to **Integrate calendar** and copy the **Calendar ID**. It looks like
   `c_8f3a…@group.calendar.google.com`.

### A4. Put the calendar ID in `.env`

```ini
CALENDAR_ID=c_8f3a…@group.calendar.google.com
```

That is all of it — no `GOOGLE_CLIENT_ID`, no `GOOGLE_CLIENT_SECRET`, and **no `npm run auth`**. The
key file is the credential.

### A5. Check it

```sh
npm start
curl -s http://127.0.0.1:4317/health | grep -o '"credential":"[^"]*"'   # "service-account"
curl -s -X POST http://127.0.0.1:4317/sync
```

`GET /health` and `GET /sync/status` report `credential` (`service-account`, `oauth`, `none` or
`invalid`), the `calendarId` in use, and `owned: false` — which means the calendar is yours and the
planner will never create or replace it. The events should appear in Google Calendar within seconds,
on every device signed into your account.

**If the sync fails with 404.** The message names the calendar and tells you to check its sharing.
Either `CALENDAR_ID` has a typo, or step A3.4 did not take — open the calendar's **Settings and
sharing** and confirm the service account's email is still listed with "Make changes to events".
The planner deliberately does **not** create a replacement calendar here: a calendar it created
would belong to the service account rather than to you, which means it would be invisible in your
Google Calendar, and every sync would report success for ever while nothing ever appeared.

### Revoking it

Remove the service account from that calendar's sharing list, and it loses access immediately. To
retire the credential itself, delete the key on the service account's **Keys** tab. There is no grant
on your Google account to revoke, because none was ever made.

---

## B · OAuth

The planner creates and owns a calendar called **Study plan**, using the OAuth scope
`https://www.googleapis.com/auth/calendar.app.created`. That scope lets the app create calendars and
manage only the calendars it created; it cannot read or change any of your other calendars.

**Note the 7-day expiry** before choosing this: while the Cloud app is in Testing mode, Google
invalidates the refresh token after seven days, and you have to run `npm run auth` again. Publishing
to Production removes that, but requires an app domain, a privacy policy and a terms-of-service URL
on a domain you have verified in Search Console.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in with the Google account whose calendar you want to use.
2. Click the project picker in the top bar (next to the "Google Cloud" logo), then **New project**.
3. Project name: `daymark` (any name works). Leave Organization / Location as they are. Click **Create**.
4. Wait for the notification, then click **Select project**, so the top bar shows `daymark`.

## 2. Enable the Google Calendar API

1. Open the ☰ menu, then **APIs & Services → Library**.
2. Search for **Google Calendar API** and open it.
3. Click **Enable**.

## 3. Configure the Google Auth Platform (OAuth consent screen)

Open the ☰ menu, then **APIs & Services → OAuth consent screen**. This takes you to **Google Auth
Platform** (<https://console.cloud.google.com/auth/overview>). If it says "Google Auth Platform not
configured yet", click **Get started** and fill in the wizard:

- **App information:** App name `Study planner`. User support email: your address.
- **Audience:** **External**. Internal only exists for Google Workspace organizations.
- **Contact information:** your email.
- **Finish:** accept the user data policy, then click **Create**.

Then check each section in the left menu.

### Branding
The app name and support email are already set. Leave the logo, app domain and authorized domains empty
(a logo would trigger brand verification).
Click **Save** if you changed anything.

### Audience
1. **Publishing status:** starts as **Testing**. See [Troubleshooting](#refresh-token-expires-after-7-days) before you decide whether to keep it.
2. Under **Test users**, click **+ Add users**, enter your own Gmail address, then **Save**.
   While the app is in Testing, only listed test users can authorize it.

### Data Access
1. Click **Add or remove scopes**.
2. In the filter box, type `calendar.app.created`. Tick the row
   **`.../auth/calendar.app.created`** ("Make secondary Google calendars, and see, create, change, and delete events on them").
   If you can't find it, paste `https://www.googleapis.com/auth/calendar.app.created` into
   **Manually add scopes** at the bottom, then click **Add to table**.
3. Click **Update**, then **Save**. Don't add any other scope. The app requests only this one.

### Clients
1. Click **+ Create client**.
2. **Application type:** **Desktop app**. Name: `Study planner CLI`.
3. Click **Create**. A dialog shows the **Client ID** and **Client secret**. Copy both now. Newer
   consoles only show the secret once; you can still download the JSON from the client's page.
   Desktop clients need no redirect URI. Google allows any `http://127.0.0.1:<port>` loopback address
   for them.

## 4. Put the credentials in `.env`

In the repo root:

```powershell
Copy-Item .env.example .env      # bash: cp .env.example .env
notepad .env
```

```
GOOGLE_CLIENT_ID=1234567890-abc...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

`.env` is gitignored. For a Desktop app the "secret" isn't really secret (Google says so for installed
apps), but still don't commit it.

## 5. Authorize

In the repo root:

```sh
npm run auth        # same as: npm run auth -w @planner/calendar
```

1. A browser tab opens on Google's consent page. The terminal also prints the URL, so you can paste it
   by hand if no tab opens. To only print it, run `npm run auth -- --no-browser`.
2. Pick your account. You'll see **"Google hasn't verified this app"**. That's expected for your own
   unverified app. Click **Continue** (or **Advanced → Go to Study planner (unsafe)**).
3. Allow the calendar permission. If there's a checkbox, tick it.
4. The tab says **"Study planner connected"**. The terminal prints `Authorized. Token saved to <repo root>/.data/google-token.json`.

The token file holds the refresh token. It's written with mode 0600 where the OS supports it (on Windows it
inherits your user profile's ACLs) and it's gitignored via `.data/`. The first sync creates the
**Study plan** calendar. You'll see it under "My calendars" in Google Calendar.

To disconnect: delete `.data/google-token.json`, then revoke the app at
<https://myaccount.google.com/connections>.

## Troubleshooting

### The browser didn't open / "This site can't be reached" after consent
- The CLI listens on `http://127.0.0.1:<random port>` only while it's waiting. If you closed the terminal
  or it timed out (5 minutes), run `npm run auth` again and use the **new** URL. Each URL embeds its own
  port and one-time PKCE challenge.
- Open the URL in a browser on the **same machine**. The redirect goes to 127.0.0.1, so it won't work from a phone or another PC.
- A VPN, proxy or security tool that intercepts loopback traffic can block the redirect. Allow `127.0.0.1` or turn it off briefly.
- `Error 400: redirect_uri_mismatch` means the client isn't of type **Desktop app**. Web clients need
  registered redirect URIs. Create a Desktop app client (step 3, Clients) and update `.env`.
- `Error 401: invalid_client` means the ID or secret in `.env` is wrong or has stray spaces or quotes. Copy them again.

### Sync fails with 404 and a message about sharing (service account)

The credential works but cannot see the calendar. Either `CALENDAR_ID` is wrong, or the sharing from
step A3.4 is missing or was removed. Open that calendar's **Settings and sharing** and check the
service account's email is listed with **Make changes to events**. Nothing is created in its place
on purpose — see A5.

### `.data/google-service-account.json is not a service-account key`

You saved the **OAuth client** JSON instead of the service-account key. They look alike and land in
the same folder. The right file comes from the service account's **Keys** tab and has
`"type": "service_account"` at the top. The OAuth client file has an `"installed"` or `"web"` key
instead.

### `GET /health` says `"credential":"oauth"` but you installed a key

The key is not where the service expects it. It must be exactly
`.data/google-service-account.json`, next to `google-token.json`, in the data directory the service
is using (`PLANNER_DATA_DIR` if you set it, otherwise `<repo>/.data`). A key in the repo root or in
your Downloads folder is not read.

### `GET /health` says `"credential":"invalid"`

The key file is there but unusable — malformed JSON, or missing `client_email` / `private_key`. The
API log line says which. The planner refuses it rather than quietly falling back to OAuth, because
silently ignoring a credential you installed on purpose is worse than failing.

### Sync fails with 403 `accessNotConfigured` ("Google Calendar API has not been used in project …")
Authorization succeeded, but step 2 was skipped: consent is *your* permission, and enabling the API is
the *project's*. They are separate, so `npm run auth` passes and the first `POST /sync` is what fails.
Open the link in the error message (it is pre-filled with your project), click **Enable**, wait a minute
for it to propagate, and `POST /sync` again. Nothing is lost: the failed sync leaves the plan untouched
and stays queued.

### "Access blocked: Study planner has not completed the Google verification process" (Error 403: access_denied)
The app is in **Testing** and the account you picked isn't a test user. Open Google Auth Platform →
**Audience** → **Test users** → **+ Add users**, add the exact Gmail address, save, and retry (it can take a
minute). This is different from the **"Google hasn't verified this app"** warning, which you can click through.

### Refresh token expires after 7 days
While **Publishing status = Testing**, Google expires refresh tokens after **7 days** for any scope beyond
basic profile. Sync then fails with `invalid_grant`, and the API reports `CALENDAR_NOT_AUTHORIZED` (HTTP 503) with the hint
"run `npm run auth`". Two options:

1. **Recommended for personal use:** open Google Auth Platform → **Audience**, then **Publish app** and
   **Confirm**, so the status becomes **In production**. You don't need to submit for verification
   to use it yourself. You keep seeing the "Google hasn't verified this app" warning at consent, and
   unverified apps are capped at 100 users, which is fine here. Then run `npm run auth` once more.
   Tokens issued in production status don't expire on a timer. They still stop working if you revoke
   access, change your Google password (for some account types), or leave the token unused for 6 months.
2. Stay in Testing and run `npm run auth` every week.

### "Google returned no refresh_token"
Google issues a refresh token only on a fresh consent. The CLI always sends `prompt=consent`. If it still
happens, remove the app at <https://myaccount.google.com/connections> and run `npm run auth` again.

### "The calendar permission was not granted"
You unticked the calendar checkbox on the consent screen. Run `npm run auth` again and leave it ticked.

### The "Study plan" calendar was deleted
The next sync notices the 404, creates a new "Study plan" calendar, stores its id and fills it again. Events in
other calendars are never read or touched. That's the point of `calendar.app.created`.
