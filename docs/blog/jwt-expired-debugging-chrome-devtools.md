# Your JWT Is Expired and That's Why Everything Is on Fire

Debugging · March 15, 2026 · 6 min read · JWT, Auth, Chrome DevTools
By TraceLens, https://tracelens.site/blog/jwt-expired-debugging-chrome-devtools/

It's 4pm on a Friday. A customer just filed a ticket: *"The dashboard is broken. Nothing loads."* You check the backend logs. Healthy. You check the database. Fine. You ask the customer to send a screenshot. It's a white screen. You paste the URL yourself and everything works perfectly.

You type the four most dangerous words in software engineering: **"It works for me."**

Then, because you're a professional, you open DevTools instead of closing the ticket. And right there, staring back at you from the Network tab, is a column of **401 Unauthorized** responses. Every single API call. Rejected.

It's the JWT. It's almost always the JWT.

## What even is a JWT?

A JSON Web Token (JWT) is how most modern apps prove who you are to an API. When you log in, the server hands you a token, a long, base64-encoded string that looks like someone fell asleep on their keyboard:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEyMyIsImVtYWlsIjoidXNlckBleGFtcGxlLmNvbSIsInJvbGUiOiJhZG1pbiIsImV4cCI6MTc0MjA0ODAwMH0.xK9mN2pQ...
```

It has three parts separated by dots: a header, a payload, and a signature. The payload is the interesting bit. It contains your user ID, email, role, and crucially an `exp` field that says when the token dies.

When the token expires, every request that uses it gets a 401. The server isn't being rude. It's just following the rules you set up.

## The classic JWT debugging experience

Here's what debugging a JWT problem normally looks like:

1. Open DevTools Network tab
2. Find a failing request
3. Click it, scroll to Request Headers
4. Find the `Authorization` header; it's a 400-character wall of text
5. Copy everything after "Bearer "
6. Open a new tab, go to jwt.io
7. Paste the token
8. Read the decoded payload
9. See that `exp` was 47 minutes ago
10. Close jwt.io, go back to DevTools
11. Realise you've already lost focus on which request you were looking at
12. Start over

This is the workflow. Millions of developers do this exact thing every single day. It's perfectly functional the way eating soup with a fork is perfectly functional.

## What the token is actually telling you

Once you decode the JWT payload, you get something like this:

```json
{
  "sub": "user_123",
  "email": "user@example.com",
  "role": "admin",
  "iat": 1742044400,   // issued at, Unix timestamp
  "exp": 1742048000    // expires at, also Unix timestamp
}
```

The `iat` and `exp` fields are Unix timestamps. To know if the token is expired, you compare `exp` to the current time. If `exp` is in the past, your token is toast.

The gap between `iat` and `exp` tells you the token lifetime. 3600 seconds = 1 hour. 900 seconds = 15 minutes. Some auth systems issue tokens that expire in 15 minutes because they're security-conscious. Some issue tokens that expire in 30 days because they're not.

## The five JWT problems that cause 80% of incidents

### 1. The token expired and nobody refreshed it

The most common one. Your app gets a token on login, uses it for an hour, and then forgets to refresh it. The user doesn't log out; they just... stop working. Usually they notice when they try to do something important, like submitting a form after writing a long message.

**How to spot it:** check the `exp` field. Is it in the past? Yes? That's your problem. The fix is in your auth layer: implement token refresh logic, or show the user a "session expired, please log in again" message before they lose their work.

### 2. The token is from the wrong environment

A developer copies a token from the staging environment and tests with it in production. Or vice versa. The signature won't match because the signing secret is different. The server rejects it with a 401 and gives no further explanation because it's not obligated to help you debug your copy-paste mistakes.

### 3. The clock is wrong

JWT expiry is time-based. If the server clock and the client clock disagree by more than a few minutes, perfectly valid tokens get rejected as expired, or worse, already-expired tokens get accepted. This is rare on modern cloud infrastructure but shows up on IoT devices, VMs with bad time sync, and laptops that have been in airplane mode for a long time.

### 4. The role is wrong

The token is valid and not expired, but the `role` field says `"viewer"` and the endpoint requires `"admin"`. The server returns a 403 (Forbidden) rather than a 401, but the symptom is similar: everything appears broken. The user swears they're an admin. They were an admin. Last week, someone changed their role in the database but they haven't logged out and back in to get a fresh token with the updated claims.

### 5. The token isn't being sent at all

The Authorization header is simply missing. This happens more than you'd think: a new API endpoint was added without auth middleware, a frontend refactor dropped the header from one specific fetch call, or the token is stored in a cookie and the request doesn't have `credentials: 'include'`. The server sees an anonymous request and returns 401.

## How to stop doing the jwt.io shuffle

[TraceLens](https://tracelens.site) decodes every JWT it finds automatically, with no tab switching and no copy-pasting. It reads the `Authorization: Bearer` header on every captured request, decodes the token inline, and shows you the subject, email, role, algorithm, issued time, expiry, and a live countdown bar showing how many minutes are left.

If the token is expired, the badge turns red and says **EXPIRED**. If it expires in less than 5 minutes, the countdown bar goes yellow. You see this on every single request, without clicking anything extra.

And because TraceLens is read-only and runs entirely inside your browser, the token never leaves your machine. Which matters, because JWT tokens are credentials, and pasting them into random websites is the kind of thing security teams write post-mortems about.

## The checklist when you get a 401

1. **Is the Authorization header present?** Check Request Headers. If it's missing, the token isn't being sent.
2. **Is the token expired?** Decode the `exp` field. Compare to now.
3. **Is this the right environment?** Check the `sub` or `email` to confirm the token belongs to the expected user in the expected environment.
4. **Does the role match what the endpoint requires?** Check the `role` or `roles` claim.
5. **Is the clock in sync?** If everything looks right but it still fails, check server time.

Most 401s are solved at step 2. The token is expired. Refresh it, log in again, and move on with your life.

## FAQ

### How do I decode a JWT token in Chrome DevTools?

Open DevTools, then the Network tab, click any request with an `Authorization` header, look at Request Headers, copy the value after "Bearer " and paste it into jwt.io. Or install [TraceLens](https://tracelens.site) and it decodes every token automatically inside DevTools.

### Why does my JWT keep expiring too quickly?

Your auth server sets the expiry, usually 15 to 60 minutes for access tokens. This is intentional for security. The solution is a refresh token flow: when the access token expires, use a long-lived refresh token to get a new one silently without logging the user out.

### What's the difference between 401 and 403?

**401 Unauthorized** means the request has no valid authentication: the token is missing, expired, or malformed. **403 Forbidden** means the token is valid and the user is authenticated, but they don't have permission to do what they're trying to do. Same symptom (things don't work), different cause.

---

Next time everything's on fire on a Friday afternoon, open DevTools, look at the 401s, and check the token first. Nine times out of ten, that's your answer. The tenth time it's a DNS problem. There's always a tenth time.

[TraceLens](https://tracelens.site) is a free Chrome DevTools extension that decodes JWTs automatically, shows live expiry countdowns, and helps you stop doing the jwt.io shuffle. [Open source on GitHub.](https://github.com/Siddharthachuahan9/TRACELENS)

More articles: https://tracelens.site/blog.md
