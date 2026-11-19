# 20. Local MongoDB with Docker

Optional. Use this to run database tests or the browser E2E without the cloud database.
Normal development and production use MongoDB Atlas; nothing in the app requires Docker.

CI starts the same pinned `mongo:7.0.48` image as a service container, and the `compose-mongo`
job boots this exact file on every pull request as a required check, so the laptop and CI use
the same database version and the file cannot drift unnoticed. Dependabot tracks 7.0 patch
releases weekly; a major upgrade stays a deliberate change.

## Before you start

- Docker Desktop installed and running. Check with `docker version` — it must print a
  **Server** section. Docker is not installed on this laptop as of 2026-11-19.
- The repository at `C:/Users/jeffe/inventory-ai`.

## Start the database

```bash
cd C:/Users/jeffe/inventory-ai
docker compose up -d mongo
docker compose ps          # wait until STATUS says "healthy"
```

## Point the backend at it

Edit `server/.env` and set:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017
```

The test guards still select `inventoryai_test_db`; they refuse development and
production databases. Keep the Atlas URI for normal app work, and do not use this
setting in production.

## Run the tests

```bash
cd C:/Users/jeffe/inventory-ai/server
npm test
npm run test:webauthn-e2e     # also needs Chrome
```

## Stop or reset

```bash
docker compose down           # stop; keeps data
docker compose down -v        # ⚠️ stop and delete the local container's data
```

`down -v` affects only this Docker volume. It cannot reach Atlas.

## If it does not work

| Symptom | Cause and fix |
| --- | --- |
| `docker: command not found` | Docker Desktop is not installed, or its terminal is not open. |
| Port 27017 is already in use | Another MongoDB is running. Stop it, or change the host port in `compose.yaml` and in `MONGODB_URI`. |
| Tests still use Atlas | `server/.env` or the shell still exports the old `MONGODB_URI`. |
| `ps` never says `healthy` | Read `docker compose logs mongo`; the port conflict above is the usual cause. |
