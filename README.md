# Smart Campus: Infrastructure and Lost-and-Found

Full-stack version: an Express REST API with a SQLite database, serving the single-page frontend from `public/`.
All data (users, complaints, photos, lost and found items, notifications) is stored on disk and survives restarts.

## Run it

Requires Node.js 22.13 or newer (it uses Node's built-in SQLite, so there is nothing to compile).

```bash
npm install
npm start
```

Open http://localhost:3000. On the first start the database is created at `data/campus.db` and filled with demo data.

Demo accounts (password `campus123`):

| Role | Email |
|---|---|
| Student | nikish@campus.edu |
| Staff | meera@campus.edu |
| Technician | ravi@campus.edu |
| Admin | priya@campus.edu |

For anything beyond local use, copy the variables from `.env.example` into your environment. At minimum set
`JWT_SECRET` (a long random string) and `NODE_ENV=production`, and set `DEMO_LOGINS=off` and `SEED=off`.
With `SEED=off`, provide `ADMIN_EMAIL` and `ADMIN_PASSWORD` once to create the first admin.

## Layout

```
server.js        Express app: auth, all API routes, static hosting
src/db.js        SQLite schema, demo seed data
src/matching.js  Lost/found match scoring (used by the server)
public/index.html  The frontend (talks to /api with a JWT)
data/            campus.db and uploaded photos (created at runtime, git-ignored)
```

## What the backend does

- Passwords are hashed with bcrypt. Sign-in returns a JWT valid for 8 hours. Repeated failed sign-ins are rate limited.
- Every route checks the role. Students only receive their own complaints, technicians only their assigned ones.
- Status changes follow the workflow: the assigned technician moves Assigned to In Progress to Resolved, and the
  owner or an admin closes it.
- Photos are validated (type and size), saved to `data/uploads`, and served from `/uploads`.
- Matching runs on the server whenever items are reported. Staff and admins approve or reject suggestions.
- Notifications are stored per user; the page checks for new ones every 20 seconds.
- New sign-ups are always student accounts. Admins change roles, deactivate users and issue temporary passwords.

## API

| Method and path | Who | Purpose |
|---|---|---|
| POST /api/auth/login, /register, /forgot | anyone | Sign in, sign up, request a reset |
| GET /api/bootstrap | signed in | Everything the role may see |
| GET, PATCH /api/me | signed in | Own profile |
| POST /api/complaints | student, staff | New complaint with photos |
| POST /api/complaints/:id/assign | admin | Assign a technician |
| POST /api/complaints/:id/status | technician, owner, admin | Move along the workflow |
| POST /api/complaints/:id/notes | technician, admin | Add a work note |
| POST /api/lost, /api/found | student, staff | Report an item |
| POST /api/found/:id/claim | student, staff | Claim a found item |
| POST /api/found/:id/return | staff, admin | Approve a claim |
| POST /api/lost/:id/recover | owner | Mark as recovered |
| POST /api/matches/decide | staff, admin | Approve or reject a match |
| POST /api/users, PATCH /api/users/:id, POST /api/users/:id/reset-password | admin | Manage users |
| POST /api/categories, DELETE /api/categories/:name | admin | Manage categories |
| GET /api/notifications, POST /api/notifications/read | signed in | Notifications |

## Before you put it online

- Serve it behind HTTPS (a reverse proxy such as Nginx or Caddy, or a host that provides it).
- Back up `data/` regularly; it holds the database and the photos.
- Password reset emails are not built in. Admins issue temporary passwords from the Users page.
