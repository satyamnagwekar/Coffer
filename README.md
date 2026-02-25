# 🏛 Coffer — Backend

Full-stack precious metals tracker. Node.js + SQLite backend with the Coffer frontend bundled in `public/`.

---

## Deploy to Railway (free, ~5 minutes)

### Step 1 — Create a GitHub repository

1. Go to [github.com/new](https://github.com/new)
2. Name it `coffer` (private is fine)
3. Click **Create repository**
4. Upload all these files to it (drag and drop works on GitHub's web UI)

### Step 2 — Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Select your `coffer` repository
4. Railway will detect the Node.js app and deploy automatically

### Step 3 — Set environment variables

In Railway dashboard → your project → **Variables**, add:

| Variable | Value |
|----------|-------|
| `JWT_SECRET` | Any long random string, e.g. `coffer-xK9mP2vL8nQ4wR7sT1uY3zA6bC5dE0f` |
| `PORT` | `3000` (Railway sets this automatically, you can skip) |

### Step 4 — Add a volume (so data survives redeploys)

1. In Railway → your service → **Volumes**
2. Click **Add Volume**
3. Mount path: `/app/data`

That's it. Railway gives you a URL like `https://coffer-production.up.railway.app`.
Your app is live. Share that URL with anyone.

---

## Run locally (for testing)

```bash
npm install
node server.js
# Open http://localhost:3000
```

---

## API Reference

All endpoints under `/api`. Protected routes require `Authorization: Bearer <token>`.

### Auth
| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | `{email, password, firstName, lastName, age, country}` | Create account |
| POST | `/api/auth/login` | `{email, password}` | Sign in |
| GET | `/api/auth/me` | — | Get current user |
| PATCH | `/api/auth/profile` | `{firstName, lastName, ...}` | Update profile |
| DELETE | `/api/auth/account` | — | Delete account |

### Prices
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/prices` | Live gold/silver spot + FX rates |

### Items (protected)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/items` | All holdings |
| POST | `/api/items` | Add holding |
| PUT | `/api/items/:id` | Update holding |
| DELETE | `/api/items/:id` | Delete holding |

### Alerts (protected)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/alerts` | All price alerts |
| POST | `/api/alerts` | Create alert |
| PATCH | `/api/alerts/:id/fired` | Mark alert as fired |
| DELETE | `/api/alerts/:id` | Delete alert |

---

## Security notes

- Passwords are hashed with **bcrypt** (cost factor 12)
- Auth tokens are **JWT** signed with your `JWT_SECRET`, expire in 30 days
- SQLite runs in WAL mode with foreign key enforcement
- Receipts are stored as base64 in the DB (max 10MB per request)
- For production: set a strong `JWT_SECRET` and restrict CORS to your domain

---

## Tech stack

- **Runtime**: Node.js 18+
- **Framework**: Express
- **Database**: SQLite via better-sqlite3 (file-based, zero config)
- **Auth**: bcryptjs + jsonwebtoken
- **Price refresh**: node-cron (every 5 minutes)
- **Frontend**: Vanilla HTML/CSS/JS in `public/`
