# FieldsCraft Lawn Care

Professional website for Bromley FieldsCraft Lawn Care — static site on Vercel with Stripe Checkout Sessions.

## Booking & payments

1. Customer fills out `book.html` (name, phone, email, address, date, time window, clippings preference, notes, service).
2. Frontend POSTs JSON to `/api/create-checkout-session` (no secret key in the browser).
3. Serverless function creates a Stripe Checkout Session with:
   - Main service line item (Basic Mow or Full Yard Service)
   - Tip for Bromley (custom amount — customer enters any tip)
   - Optional add-ons: Flower Watering, Dog Poop Pickup
   - Booking details in session `metadata`
4. Customer pays on Stripe Checkout, then lands on `thank-you.html`.

## Environment variables (Vercel)

| Name | Where | Purpose |
|------|--------|---------|
| `STRIPE_SECRET_KEY` | Server only (Preview + Production) | Creates Checkout Sessions |
| `STRIPE_PUBLISHABLE_KEY` | Optional for future Elements | Not required for this flow |
| `SITE_URL` | Optional | e.g. `https://www.fieldscraft.com` for fixed success/cancel URLs |

## Local

```bash
npm install
vercel dev
```

## Deploy

Push to `main` — Vercel builds and deploys automatically. Or run `vercel --prod`.
