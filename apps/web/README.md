# Nexus Frontend

Next.js web application for Nexus. This is the BFF (Backend for Frontend) that proxies requests to FastAPI.

## Architecture

```
Browser → Next.js (this app) → FastAPI → Database
```

The browser **never** calls FastAPI directly. All requests go through Next.js route handlers which:
1. Extract the Supabase access token from the session
2. Attach `Authorization: Bearer <token>` header
3. Attach `X-Nexus-Internal` header (BFF authentication)
4. Forward the request to FastAPI
5. Return the response to the browser

## Setup

```bash
# From repo root
cd apps/web
npm install
```

## Development

```bash
# Start the development server
npm run dev

# Or from repo root
make web
```

The app runs at http://localhost:3000 by default.

**Note**: The FastAPI server must be running for the app to work. Start it with `make api` from the repo root.

## Environment Variables

Create `.env.local` for local development:

```bash
# Required: FastAPI backend URL
FASTAPI_BASE_URL=http://localhost:8000

# Required: Supabase configuration
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key

# Optional: Environment (default: local)
NEXUS_ENV=local

# Required in staging/prod: Internal API secret
NEXUS_INTERNAL_SECRET=your-secret
```

## Project Structure

```
src/
├── app/                    # Next.js app router
│   ├── api/                # BFF proxy routes (mirror FastAPI paths)
│   │   ├── me/
│   │   ├── libraries/
│   │   └── media/
│   ├── (authenticated)/    # Protected pages (require login)
│   │   ├── libraries/
│   │   └── media/
│   ├── login/              # Login page
│   └── auth/               # Auth callbacks
├── components/             # React components
│   ├── HtmlRenderer.tsx    # ONLY place with dangerouslySetInnerHTML
│   ├── Navbar.tsx
│   ├── Pane.tsx
│   └── ...
├── lib/                    # Utilities
│   ├── api/                # API client helpers
│   ├── supabase/           # Supabase client setup
│   └── env.ts              # Environment configuration
└── middleware.ts           # Auth redirect + CSP
```

## Key Constraints

### Security

- **No tokens in localStorage**: Access tokens exist only in server runtime
- **Single HtmlRenderer**: Only component allowed to use `dangerouslySetInnerHTML`
- **BFF only**: All browser → backend traffic goes through Next.js

### Route Handlers

Each route handler must:
- Be 3-10 lines of actual logic
- Delegate to `proxyToFastAPI()` for all backend communication
- NOT perform custom request shaping beyond path parameters
- NOT add business logic (that belongs in FastAPI)

Example:
```typescript
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { id } = await params;
  return proxyToFastAPI(req, `/libraries/${id}`);
}
```

## Testing

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests for CI
npm run test:ci
```

## Linting

```bash
npm run lint
```

## Building

```bash
npm run build
npm start
```
