# Product

## Register

product

## Users

Frontend developers debugging their own API calls during development, and support engineers investigating customer issues on production sites. Both use TraceLens inside Chrome DevTools — a high-focus, low-distraction environment. The tool runs while they work, not as the primary focus. A support engineer may share a screen with a client; a developer may glance at it mid-flow.

## Product Purpose

TraceLens captures network requests in real time, groups them by user action, diagnoses performance issues, decodes JWTs, and generates shareable incident reports — all without leaving the browser and without sending any data anywhere. It is strictly read-only. Success means a developer or support engineer resolves an issue faster than they would without it.

## Brand Personality

Professional, calm, reliable. The tool that is always right. Never flashy. Never in the way.

## Anti-references

- Generic SaaS dashboard: gradient cards, hero metrics, teal-and-white color schemes, Stripe/Intercom visual language
- Hacker/neon aesthetic: neon on black, cyberpunk glow effects, aggressive phosphor greens
- Chrome DevTools default: system fonts, flat gray with no personality, purely utilitarian
- Heavy enterprise tooling: dense tables, navy blue, IBM/SAP visual weight

## Design Principles

1. **Information is the interface** — the data is the product; chrome never competes with content
2. **Calm under pressure** — when a production incident is happening, the tool must not add visual noise
3. **Earned restraint** — every visual element must justify its presence; decoration is a cost
4. **Invisible safety** — the privacy model (no page injection, no data exfiltration) should be legible in the design itself
5. **Expert confidence** — no onboarding nudges, no tooltips explaining obvious things; trust the user

## Accessibility & Inclusion

WCAG AA minimum. Keyboard-first navigation (vim-style J/K already implemented). Themes must maintain contrast ratios across all 4 variants. `prefers-reduced-motion` should be respected.
