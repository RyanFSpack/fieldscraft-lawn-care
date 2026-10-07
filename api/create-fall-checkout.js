/**
 * /api/create-fall-checkout
 * -----------------------------------------------------------------------------
 * NEW checkout path for Fall Fest 2026 only.
 *
 * Do NOT route book.html or weekly.html here. Those still use
 * /api/create-checkout-session.js and must keep their existing behavior.
 *
 * Two offers:
 *
 *  A) Spring 2027 starter lock-in  (fair-promo.html, offer=spring_starter)
 *     - $30 deposit charged TODAY (one-time). Nothing else.
 *     - Customer is created and saved. Card is saved for the later $30.
 *     - NO weekly subscription. Do not attach basic_weekly or full_weekly.
 *     - The other $30 is NOT charged today. Ryan invoices that once from the
 *       Dashboard when mowing actually starts (see SPRING CHARGE below).
 *
 *  B) Leaf pickup  (leaf-pickup.html, offer=leaf_pickup)
 *     - One-time $40. No subscription. No haul-away.
 *
 * LIVE Price IDs. Use these exactly. Do not use a prod_ ID. Do not look up
 * or create a Price at request time — a wrong lookup would charge the wrong
 * amount at the booth.
 *
 *   Deposit, charge today on /fair-promo only:
 *     price_1UNviQIwpXk8ife0vdd9vxSl
 *     Product: Spring 2027 Starter Deposit, $30 one-time
 *
 *   Balance, do NOT charge on any fair page:
 *     price_1UNvjSIwpXk8ife0JSt1ZOm3
 *     Product: Spring 2027 Starter Balance, $30 one-time
 *     Ryan invoices this later from the Dashboard. Stored below so spring
 *     billing has the ID. Never put it in line_items.
 *
 *   Leaf, charge on /leaf-pickup only:
 *     price_1UNvkUIwpXk8ife0mSaQb62h
 *     Product: Fall Leaf Pickup, $40 one-time
 *
 * Do not charge basic_weekly (price_1TuxzEIwpXk8ife0iLcI5L4R) or
 * full_weekly (price_1TuxyXIwpXk8ife0gx9HvW6T) from these pages.
 * book.html and weekly.html still use /api/create-checkout-session.js.
 *
 * -----------------------------------------------------------------------------
 * HOW THE $30 DEPOSIT + SAVED CUSTOMER WORKS
 * -----------------------------------------------------------------------------
 * spring_starter Checkout Session (implemented below):
 *   - mode: 'payment'
 *   - one line item: one-time Price "Spring 2027 Starter Deposit" ($30)
 *   - customer_creation: 'always' so the Customer is saved
 *   - payment_intent_data.setup_future_usage = 'off_session' so the card
 *     is saved on that Customer for the later $30
 *   - NO subscription is created
 *   - NO weekly price (basic_weekly / full_weekly) is attached
 *
 * Ryan, in spring:
 *   1. Text in March 2027 to confirm they still live there and pick a day.
 *   2. If they moved and told us: refund the $30 deposit. Do not guess —
 *      they have to contact us.
 *   3. When mowing actually starts (target window late April 2027; weather
 *      may push this to early May — never promise a specific start date):
 *      charge the remaining $30 ONCE as a one-time invoice.
 *
 * The remaining $30 is never a silent automatic charge and is never a line
 * item on these pages. Ryan invoices price_1UNvjSIwpXk8ife0JSt1ZOm3 from the
 * Dashboard when mowing starts.
 * -----------------------------------------------------------------------------
 */

const Stripe = require('stripe');

// Charge today on /fair-promo only. Spring 2027 Starter Deposit, $30 one-time.
const SPRING_DEPOSIT_PRICE_ID = 'price_1UNviQIwpXk8ife0vdd9vxSl';

// Do NOT charge on any fair page. Spring 2027 Starter Balance, $30 one-time.
// Ryan invoices this later from the Dashboard. Stored here so spring billing
// has the ID. Never add it to line_items.
const SPRING_BALANCE_PRICE_ID = 'price_1UNvjSIwpXk8ife0JSt1ZOm3';

// Charge on /leaf-pickup only. Fall Leaf Pickup, $40 one-time.
const LEAF_PICKUP_PRICE_ID = 'price_1UNvkUIwpXk8ife0mSaQb62h';

// Weekly plans must never be charged from this file.
const FORBIDDEN_PRICE_IDS = [
  'price_1TuxzEIwpXk8ife0iLcI5L4R', // basic_weekly
  'price_1TuxyXIwpXk8ife0gx9HvW6T', // full_weekly
  SPRING_BALANCE_PRICE_ID,
];

function getSiteOrigin(req) {
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.length) {
    return JSON.parse(req.body);
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clip(value, max) {
  return String(value || '').trim().slice(0, max || 500);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Quiet flag only. Never reject a payment because of it, and never show it
 * to the customer. Fort Collins, 80528, or 80525 marks kechter_farm.
 */
function neighborhoodFlag(address) {
  const text = String(address || '').toLowerCase();
  if (text.includes('fort collins') || /\b80528\b/.test(text) || /\b80525\b/.test(text)) {
    return 'kechter_farm';
  }
  return 'review';
}

/**
 * Charge only the live Price ID for this offer. Ignore any other client
 * priceId. Never a prod_ ID, never a lookup, never a Price created here.
 */
function priceIdForOffer(offer, requestedPriceId) {
  const expected =
    offer === 'leaf_pickup' ? LEAF_PICKUP_PRICE_ID : SPRING_DEPOSIT_PRICE_ID;
  const requested = String(requestedPriceId || '').trim();
  if (requested && requested !== expected) {
    throw new Error('That Price is not charged from this page.');
  }
  if (!/^price_[A-Za-z0-9]+$/.test(expected) || expected.indexOf('prod_') !== -1) {
    throw new Error('Fall Fest checkout requires a live price_ ID.');
  }
  if (FORBIDDEN_PRICE_IDS.indexOf(expected) !== -1) {
    throw new Error('That Price must not be charged from a Fall Fest page.');
  }
  return expected;
}

function springMetadata(fields) {
  return {
    name: clip(fields.name),
    phone: clip(fields.phone),
    email: clip(fields.email),
    address: clip(fields.address),
    offer: 'spring_starter',
    deposit: '30',
    neighborhood: 'kechter_farm',
    neighborhood_flag: fields.neighborhoodFlag,
    source: 'fall_fest_2026',
    consent: 'yes',
    // Ryan-facing reminder. Not a charge. No weekly subscription on this offer.
    spring_charge_note: clip(
      'Remaining $30 is NOT charged today. No weekly subscription. Text in March 2027. Invoice price_1UNvjSIwpXk8ife0JSt1ZOm3 once from the Dashboard when mowing starts. Refund the deposit if they moved and told us before we start.',
      500
    ),
    spring_balance_price_id: SPRING_BALANCE_PRICE_ID,
  };
}

async function createSpringSession(stripe, body, origin) {
  const name = clip(fieldsName(body));
  const phone = clip(body.phone);
  const email = clip(body.email).toLowerCase();
  const address = clip(body.address);

  if (!name || !phone || !email || !address) {
    return {
      status: 400,
      payload: { error: 'Name, phone, email, and street address are required.' },
    };
  }
  if (!isEmail(email)) {
    return { status: 400, payload: { error: 'Please enter a valid email for the Stripe receipt.' } };
  }
  if (body.consent !== true && body.consent !== 'yes' && body.consent !== 'true') {
    return {
      status: 400,
      payload: { error: 'Consent to text and email about spring scheduling is required.' },
    };
  }

  const flag = neighborhoodFlag(address);
  const meta = springMetadata({ name, phone, email, address, neighborhoodFlag: flag });

  const depositPriceId = priceIdForOffer('spring_starter', body.priceId);

  // $30 deposit only. Save the customer and card. Do not start a subscription.
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: email,
    customer_creation: 'always',
    line_items: [{ price: depositPriceId, quantity: 1 }],
    payment_intent_data: {
      setup_future_usage: 'off_session',
      receipt_email: email,
      metadata: meta,
      description: 'Spring 2027 Starter Deposit — $30 today. No weekly subscription.',
    },
    metadata: meta,
    success_url: `${origin}/fair-promo-thanks.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/fair-promo.html`,
    custom_text: {
      submit: {
        message:
          'Pays $30 today only. We’ll text you in March before anything else is charged. Questions: 303.906.8597.',
      },
    },
  });

  if (session.customer) {
    try {
      await stripe.customers.update(session.customer, {
        name,
        email,
        phone,
        metadata: meta,
      });
    } catch (customerErr) {
      // Session already has the metadata. Do not fail checkout over this.
      console.error('Could not copy spring metadata onto Customer:', customerErr);
    }
  }

  return {
    status: 200,
    payload: {
      url: session.url,
      sessionId: session.id,
      mode: 'payment',
      neighborhoodFlag: flag,
    },
  };
}

async function createLeafSession(stripe, body, origin) {
  const name = clip(fieldsName(body));
  const phone = clip(body.phone);
  const email = clip(body.email).toLowerCase();
  const address = clip(body.address);
  const preferredWeek = clip(body.preferredWeek || body.preferred_week);
  const notes = clip(body.notes);
  const binConfirmed =
    body.binConfirmed === true ||
    body.bin_confirmed === 'yes' ||
    body.bin_confirmed === true ||
    body.binConfirmed === 'yes';

  if (!name || !phone || !email || !address) {
    return {
      status: 400,
      payload: { error: 'Name, phone, email, and street address are required.' },
    };
  }
  if (!isEmail(email)) {
    return { status: 400, payload: { error: 'Please enter a valid email for the Stripe receipt.' } };
  }
  if (!binConfirmed) {
    return {
      status: 400,
      payload: {
        error:
          'Leaf pickup needs a yard-waste bin on site. Check the bin box, or text Ryan at 303.906.8597.',
      },
    };
  }
  if (!preferredWeek) {
    return { status: 400, payload: { error: 'Pick a preferred week, or “as soon as you can.”' } };
  }
  if (body.consent !== true && body.consent !== 'yes' && body.consent !== 'true') {
    return { status: 400, payload: { error: 'Consent to text about the pickup day is required.' } };
  }

  // Optional tip. Default is no tip. Never create a Stripe Price for it.
  const tipAmount = Number(body.tipAmount != null ? body.tipAmount : body.tip_amount || 0);
  if (![0, 3, 5].includes(tipAmount)) {
    return { status: 400, payload: { error: 'Tip must be no tip, $3, or $5.' } };
  }

  const flag = neighborhoodFlag(address);
  const meta = {
    name,
    phone,
    email,
    address,
    offer: 'leaf_pickup',
    bin_confirmed: 'yes',
    preferred_week: preferredWeek,
    notes,
    neighborhood: 'kechter_farm',
    neighborhood_flag: flag,
    source: 'fall_fest_2026',
    consent: 'yes',
    plan: '',
    deposit: '',
    tip_amount: String(tipAmount),
  };

  const leafPriceId = priceIdForOffer('leaf_pickup', body.priceId);
  const lineItems = [{ price: leafPriceId, quantity: 1 }];
  if (tipAmount === 3 || tipAmount === 5) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: tipAmount * 100,
        product_data: { name: 'Tip for Bromley' },
      },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: email,
    customer_creation: 'always',
    line_items: lineItems,
    metadata: meta,
    payment_intent_data: {
      receipt_email: email,
      metadata: meta,
      description: 'Fall leaf pickup — leaves go in the customer yard-waste bin only. $40.',
    },
    success_url: `${origin}/leaf-thanks.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/leaf-pickup.html`,
    custom_text: {
      submit: {
        message:
          'Leaves go in your yard-waste bin only. Nothing is hauled away. Ryan will text from 303.906.8597 to confirm the day.',
      },
    },
  });

  if (session.customer) {
    try {
      await stripe.customers.update(session.customer, {
        name,
        email,
        phone,
        metadata: meta,
      });
    } catch (customerErr) {
      console.error('Could not copy leaf metadata onto Customer:', customerErr);
    }
  }

  return {
    status: 200,
    payload: {
      url: session.url,
      sessionId: session.id,
      mode: 'payment',
      neighborhoodFlag: flag,
    },
  };
}

function fieldsName(body) {
  return body.name || body.full_name || '';
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Missing STRIPE_SECRET_KEY environment variable');
    return sendJson(res, 500, {
      error: 'Payment system is not configured. Text Ryan at 303.906.8597.',
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    console.error('Invalid JSON body', err);
    return sendJson(res, 400, { error: 'Invalid request body. Expected JSON.' });
  }

  const offer = String(body.offer || body.form_type || '').trim().toLowerCase();
  const origin = getSiteOrigin(req);

  // Notify-me is a Formspree-only list. Never open Checkout for it.
  if (offer === 'notify_me' || offer === 'spring_notify') {
    return sendJson(res, 400, {
      error: 'Notify me does not take a deposit. Use the spring list form. No charge.',
    });
  }

  try {
    if (offer === 'spring_starter' || offer === 'fair_promo') {
      const result = await createSpringSession(stripe, body, origin);
      return sendJson(res, result.status, result.payload);
    }
    if (offer === 'leaf_pickup') {
      const result = await createLeafSession(stripe, body, origin);
      return sendJson(res, result.status, result.payload);
    }
    return sendJson(res, 400, {
      error: 'Unknown Fall Fest offer. Use spring_starter or leaf_pickup.',
    });
  } catch (err) {
    console.error('Fall Fest Checkout error:', err);
    return sendJson(res, 500, {
      error:
        (err && err.message) ||
        'Could not start checkout. Try again or text Ryan at 303.906.8597.',
    });
  }
};
