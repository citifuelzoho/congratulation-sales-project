# Sales Celebration Display

When a deal is won, the sales monitor shows a full-screen celebration: a glass card with **Congratulations**, the closer's name, the deal amount and **Contract completed**, with real $100 bills raining down and an optional background video.

## Project files
```
sales-celebration/
├── server.js          Receives the CRM webhook and serves the screen
├── public/
│   ├── display.html   The monitor screen
│   └── video/congratulations.mp4  (optional) your background video
├── .env.example       Settings template → copy to .env
├── package.json
├── start.bat          Double-click to run on Windows
├── start.sh           Run on Mac / Linux
├── deploy.sh          Install and run under PM2 on a Linux server
├── ecosystem.config.js  PM2 process file used by deploy.sh
└── Dockerfile         Run on a server or cloud host
```

## 1. Install Node.js
Download the LTS version from https://nodejs.org (version 18 or newer). Nothing else to install.

## 2. Settings
Copy `.env.example` to `.env` and set `WEBHOOK_SECRET` to a long random word. (The start scripts do the copy for you the first time.)

## 3. Run
- **Windows:** double-click `start.bat`
- **Mac / Linux:** `./start.sh`
- **Any system:** `npm start`

The screen opens at `http://localhost:3000`. On the monitor's computer: click once (turns on sound), press **F** for full screen.

## 4. Try it
- Use the form on the screen: type a name and amount, press **Show celebration**.
- Or open: `http://localhost:3000/test?secret=YOUR_SECRET&name=Graham%20Hatley&amount=2406`

## 5. Background video (optional)
Put an `.mp4` at `public/video/congratulations.mp4`. It plays behind the card on every win, and the celebration lasts as long as the video (max 60 s). Without it, the money rain plays on the dark blue background for 15 s.

## 6. Connect the CRM
The CRM must reach the server over the internet: run it on a cloud server (Dockerfile included), or for a trial expose your PC with `ngrok http 3000` or Cloudflare Tunnel.

Webhook URL (POST): `https://verification-process.tech/webhook?secret=YOUR_SECRET`

Fields read: closer name from `closer_name`, `deal_owner`, `owner_name`, `Owner` or `owner`; plus optional `amount` and `deal_name`. Case, spaces and underscores don't matter (`Deal Owner` = `deal_owner` = `dealOwner`), and nested fields are found too.

If the screen shows **Team**, no name field was recognised: the server log (`pm2 logs sales-celebration`) prints the payload the CRM sent, so you can see which field to map.

**Zoho CRM** — Setup → Automation → Workflow Rules → module *Deals*, when *Stage* is *Closed Won* → action *Webhook*, method POST, the URL above, parameters:
`closer_name = ${Deals.Deal Owner}`, `amount = ${Deals.Amount}`, `deal_name = ${Deals.Deal Name}`

**HubSpot** — Automation → Workflows → deal-based, trigger *Deal stage is Closed won* → *Send a webhook* (POST, URL above) with `dealname`, `amount`, `hubspot_owner_id`. Put a private-app token (scope `crm.objects.owners.read`) in `HUBSPOT_TOKEN` in `.env` so owner IDs become names.

**Zapier / Make / other** — POST JSON: `{"closer_name":"Graham Hatley","amount":2406,"deal_name":"Acme Corp"}`

## Deploy on a Linux server
Copy this folder to the server (e.g. `scp -r sales-celebration user@SERVER:~`), set `PORT` and `WEBHOOK_SECRET` in `.env`, then run:
```
sh deploy.sh
```
It installs Node.js 20 and PM2 if needed, runs the app under PM2 as `sales-celebration` using `ecosystem.config.js` (restarts on crash and reboot), opens the port in ufw/firewalld, and prints the display and webhook URLs. Run it again after every update or change in `.env`.

Logs: `pm2 logs sales-celebration`. Status: `pm2 status`. Restart: `pm2 restart sales-celebration`.

To start it by hand instead: `npm install -g pm2 && pm2 start ecosystem.config.js`.

## Run with Docker
```
docker build -t sales-celebration .
docker run -d -p 3000:3000 --env-file .env --restart unless-stopped sales-celebration
```

## Customize (in public/display.html)
- `SHOW_SECONDS` — how long each celebration shows without a video (default 15)
- `"USD"` — currency format of the amount
- Colors are at the top of the file under `:root`
