# Medisense — Patient Medicine Reminder System

A full-stack patient, prescription, and medicine reminder application. React and Vite provide the responsive interface; Express exposes an authenticated REST API; SQLite stores accounts and care records persistently.

## Requirements

- Node.js 22.5 or later
- npm

## Run locally

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API runs on port `3001` and Vite proxies `/api` requests to it. Generate a stable JWT secret with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` and set `JWT_SECRET` in `.env` to keep login sessions valid across server restarts. If it is unset, development generates a temporary cryptographically random secret; production requires `JWT_SECRET`.

The SQLite database is created automatically at `server/data/medisense.sqlite` and survives restarts. Set `DATABASE_PATH` in `.env` to choose another location. No demo accounts or sample patient records are created.

## Browser and background notifications

Grant notification permission using **Enable notifications** in the dashboard. While the app is open, it checks the server for newly scheduled reminders and shows browser notifications. To deliver notifications when the browser is closed, configure Web Push with VAPID keys in `.env`:

```powershell
npx web-push generate-vapid-keys
```

Copy the generated public and private keys into `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, set `VAPID_SUBJECT` to a contact address, then restart the app and enable notifications again. Push subscriptions are saved per account; expired subscriptions are removed automatically. Browser notification permission and a secure context are required (localhost is treated as secure by browsers).

Reminder times use the server's local timezone and are checked every 15 seconds. The scheduler records each scheduled occurrence only once, marks elapsed doses that were not recorded as delivered as missed, and stores recent sent, missed, or failed events in the notification log.

## Features

- Email/password registration and login with bcrypt password hashing and expiring JWT sessions.
- Authenticated, account-scoped patient CRUD and name/contact search.
- Prescription CRUD linked to the signed-in user's patients.
- Reminder CRUD with multiple 24-hour times, selected weekdays, date ranges, activation controls, and duplicate-occurrence protection.
- Dashboard statistics and today's schedule derived only from the signed-in user's SQLite records.
- Service worker notifications, cross-tab deduplication tags, Web Push subscriptions, and notification history.
- Responsive interface with browser-native validation and API-side validation.

## API overview

All routes except health, registration, login, and the public VAPID-key endpoint require `Authorization: Bearer <token>`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health and Web Push configuration status |
| `POST` | `/api/auth/register` | Register an account |
| `POST` | `/api/auth/login` | Sign in |
| `GET` | `/api/auth/me` | Current account |
| `GET`, `POST` | `/api/patients` | List/search or create patients |
| `PUT`, `DELETE` | `/api/patients/:id` | Update or remove a patient |
| `GET`, `POST` | `/api/prescriptions` | List or create prescriptions |
| `PUT`, `DELETE` | `/api/prescriptions/:id` | Update or remove a prescription |
| `GET`, `POST` | `/api/reminders` | List or create reminders |
| `PUT`, `DELETE` | `/api/reminders/:id` | Update or remove a reminder |
| `PATCH` | `/api/reminders/:id/active` | Activate or pause a reminder |
| `GET` | `/api/dashboard` | Account-specific counts and today's scheduled doses |
| `GET` | `/api/notifications` | Recent/new sent notifications (`?afterId=<id>` for cursor polling) |
| `GET` | `/api/notifications/logs` | Recent notification history |
| `GET` | `/api/push/public-key` | Public VAPID key, if configured |
| `POST`, `DELETE` | `/api/push/subscribe` | Save or remove a browser push subscription |

## Build and tests

```powershell
npm test
npm run build
```

The tests exercise authentication, ownership boundaries, validation, patient/prescription/reminder CRUD, dashboard queries, notification idempotency, SQLite persistence, and Web Push configuration handling.
