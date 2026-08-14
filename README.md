# Budget Tracker (PWA)

A local-first budgeting app that installs to your iPhone's home screen like a native app, with no App Store and no Apple Developer account needed. All your data stays on your device — nothing is sent to a server.

This guide assumes you've done **none** of the setup yet — a completely fresh start.

---

## What you'll need

- A Windows PC (these steps are Windows-specific; the commands are nearly identical on Mac, just installed differently)
- A free [GitHub](https://github.com) account
- An iPhone with Safari

---

## Step 1 — Install Node.js

Open **PowerShell** (search for it in the Start menu) and check if you already have it:
```
node -v
```
If you get a version number, skip to Step 2. Otherwise, go to [nodejs.org](https://nodejs.org), download the **LTS** installer for Windows, and run it with default settings.

## Step 2 — Install Git

Go to [git-scm.com](https://git-scm.com), download the Windows installer, run it — defaults are fine for every prompt.

## Step 3 — Allow PowerShell to run scripts

Windows blocks this by default. In an **admin PowerShell** (right-click PowerShell in the Start menu → *Run as administrator*):
```
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```
Type `Y` to confirm. This is a one-time, permanent setting.

## Step 4 — Unzip and install

Right-click the project zip → **Extract All** → pick a location (e.g. Desktop). Then in a normal PowerShell window:
```
cd Desktop\budget-tracker-pwa
npm install
```
Watch for red error text. If `npm install` doesn't finish cleanly, try:
```
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json
npm install
```

## Step 5 — Create a GitHub repository

1. Go to [github.com](https://github.com) → sign in (or create an account)
2. **New repository** → give it a name, e.g. `budget-tracker` (write it down exactly — you'll need it in Step 6)
3. Set it to **Public** (required for free GitHub Pages)
4. Don't check any "initialize with" boxes → **Create repository**

## Step 6 — Set the base path

Open `vite.config.ts` in any text editor (Notepad is fine). Find:
```ts
base: '/budget-tracker/',
```
Change `budget-tracker` to match your repo name from Step 5 **exactly**. Save.

> **Why this matters:** GitHub Pages serves your site from a subfolder (`yourname.github.io/repo-name/`), not the domain root. Get this wrong and the page loads blank — see Troubleshooting below.

## Step 7 — Push the code

GitHub shows you a repo URL right after Step 5 — use it here:
```
git init
git add .
git commit -m "budget tracker"
git branch -M main
git remote add origin https://github.com/EricNguyen2411/budget-tracker.git
git push -u origin main
```
First time using Git, a browser window may pop up ascking you to sign into GitHub — approve it.

## Step 8 — Turn on automatic deployment

This project includes a GitHub Actions workflow that automatically builds and publishes the site every time you push new code — no manual build step needed, ever.

1. On your repo's GitHub page → **Settings → Pages**
2. Under "Source," choose **GitHub Actions** (not "Deploy from a branch")
3. Go to the **Actions** tab on your repo — you should see a workflow run already in progress (triggered by your push in Step 7). Wait for it to finish (green checkmark, usually under a minute).
4. Back in **Settings → Pages**, your live URL now appears at the top: `https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/`

## Step 9 — Install on your iPhone

1. Open that URL in **Safari** (must be Safari, not Chrome)
2. Tap **Share** → **Add to Home Screen** → **Add**

It now sits on your home screen with its own icon and opens full-screen.

---

## How updates work

When you get new files for this project:
1. Replace the relevant files in your project folder
2. ```
   git add .
   git commit -m "update"
   git push
   ```
That's it — GitHub Actions rebuilds and republishes automatically. Check the **Actions** tab to confirm it succeeded. Your home screen icon and your data are both untouched by this; only the app's code changes.

If the update doesn't seem to show up on your phone, fully close the app first (swipe it away in your app switcher) before reopening it, rather than just switching back to it.

---

## Where your data lives

Everything is stored locally on your device, in Safari's IndexedDB, scoped to this exact URL. It never leaves your phone, and GitHub has no involvement with it — GitHub only ever serves the app's code, never your data.

**Important limitation:** iOS can clear this storage if the app goes unused for a while — a known browser behavior, not a bug. There's currently no automatic backup. Use **More → Export Full Backup** periodically and save the file somewhere safe (Files, email) until automatic backup is built.

---

## Troubleshooting

**Page loads but is completely blank, or DevTools shows a request for `/src/main.tsx`:**
This means the *raw source* is being served instead of the *built* app — almost always because Settings → Pages is set to "Deploy from a branch" instead of **GitHub Actions** (Step 8), or the workflow hasn't run yet. Check the **Actions** tab for a failed or missing run.

**`'tsc' is not recognized`:**
`npm install` didn't fully complete. Re-run it, or do a clean reinstall (see Step 4).

**PowerShell says running scripts is disabled:**
See Step 3 — this is a one-time fix.

**`git push` is rejected — "Updates were rejected... fetch first":**
Your local repo and the GitHub repo have diverged (common if you're reusing an old repo). Safest fix: create a fresh repo with a new name and push to that instead, rather than force-pushing over something that might matter.

**You're sure the fix is deployed but your browser still shows the old broken version:**
Try an **incognito/private window** first — regular browser caching is the most common cause. If it's still wrong there too, it's a real deployment issue, not caching — check the Actions tab and the Pages source setting again.

---

## Alternative: Firebase Hosting instead of GitHub Pages

If you'd rather not use GitHub Pages, [Firebase Hosting](https://firebase.google.com/docs/hosting) is a free, CLI-based alternative:
```
npm install -g firebase-tools
firebase login
firebase init hosting   # point at the "dist" folder, say yes to "single-page app"
npm run build
firebase deploy
```
If you go this route, change `base: '/budget-tracker/'` in `vite.config.ts` back to `base: '/'` — Firebase serves from the domain root, so the subfolder path isn't needed.
