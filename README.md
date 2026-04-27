# Death Reverse

Minimal online multiplayer card game for exactly 5 players.

## Run locally

```bash
npm install
npm run dev
```

Frontend: http://localhost:5173  
Backend: http://localhost:3001

## Deploy

### Backend: Render

Deploy the `server` folder as a Node web service.

```text
Root Directory: server
Build Command: npm install
Start Command: npm start
```

After Render gives you a backend URL, keep it for the frontend step.

### Frontend: Vercel

Deploy the `client` folder to Vercel. Set:

```text
VITE_SERVER_URL=https://your-backend-url
```

Use the Render backend URL as the value. Rebuild/redeploy the frontend after setting it.

Backend can be deployed from `server` to Render or Railway.
