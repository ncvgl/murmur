# Deploy

## Prerequisites

- Node.js
- Firebase CLI: `npm install -g firebase-tools`
- Logged in: `firebase login`

## Build and deploy

```bash
npm run build
firebase deploy --only hosting
```

## Custom domain

The custom domain is configured in the Firebase console under Hosting > Custom domains.

DNS: CNAME record pointing to `<project-id>.web.app`.

## First-time setup

1. `firebase login`
2. `firebase use <project-id>`
3. The `firebase.json` and `.firebaserc` files in the repo handle the rest.
