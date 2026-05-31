# Session Scribe

A Vercel app with a FastAPI (Python) backend and React (Vite) frontend.

## Project Structure

```
api/          → Python serverless function (FastAPI)
frontend/     → React app (Vite)
vercel.json   → Vercel routing & build config
```

## Local Development

### Backend

```bash
pip install fastapi uvicorn
cd api
uvicorn index:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` requests to `localhost:8000`.

## Deploy to Vercel

Push to GitHub and connect the repo in [vercel.com](https://vercel.com), or:

```bash
npm i -g vercel
vercel
```

Vercel will detect the Python runtime for `/api` and build the frontend automatically.
