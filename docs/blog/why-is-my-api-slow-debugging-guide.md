# Why Is My API Taking 3 Seconds? A Detective Story

Performance · March 15, 2026 · 7 min read · Performance, DevTools, API Debugging
By TraceLens, https://tracelens.site/blog/why-is-my-api-slow-debugging-guide/

The user opens the dashboard. A spinner appears. Three seconds pass. The data loads. They don't say anything yet, but they've already mentally filed a complaint. After this happens three more times, they file an actual complaint.

Now it's your problem.

You open the Network tab. The request is right there, `GET /api/v1/analytics/dashboard`, sitting at 2,847 ms like it has no idea what it's done. You take this personally. You click on it. And this is where most people stop, because the Timing tab looks like this:

| Phase | Time |
| --- | --- |
| DNS Lookup | 8 ms |
| TCP | 12 ms |
| SSL | 24 ms |
| Server Wait | 2,741 ms |
| Download | 62 ms |

Most people see this and think "the API is slow." That's correct but useless. The timing waterfall is telling you something much more specific, if you know how to read it.

## The waterfall is your map. Here's how to read it.

Every HTTP request travels through several phases before you get your data back. Each phase can be slow for a completely different reason. Knowing which phase is the bottleneck points you directly at the culprit.

### DNS Lookup

Translating the domain name into an IP address. Should be under 20 ms. If it's taking hundreds of milliseconds, your DNS provider is slow or the domain isn't cached. This is almost never the cause of a 3-second API call, but it's a red flag for the infrastructure setup.

### TCP Connection

Opening a connection to the server. Fast on modern infrastructure with connection pooling. If this is slow, the server is far away geographically, or you're establishing a new connection on every request instead of reusing them.

### SSL Handshake

Negotiating the encrypted connection. Should be under 100 ms. Consistently high SSL times usually mean the server's TLS configuration is outdated, or again, too far away physically.

### Server Wait (TTFB)

This is where it gets interesting. Server Wait, also called Time To First Byte, is how long the server spent thinking before it started sending back a response. **If this is high, the problem is on the server.** The request arrived. The server received it. Then it just... sat there doing things.

### Content Download

How long it took to transfer the response body from server to browser. If this is high, the response is large. You're downloading a lot of data.

## The suspects, ranked by how often they did it

### 1. The Slow Database Query

**Evidence:** Server Wait is high (90%+ of total time). Download is fast. The request arrives, and then the server waits for the database to come back before it can send anything.

**How to confirm:** Add query logging to your backend. Look for queries running over 100 ms. The analytics dashboard endpoint is a classic offender: it's probably doing aggregations across large tables with no index on the date column.

**Fix:** Add indexes. Cache the result. Pre-aggregate on a schedule instead of computing on every request.

### 2. The N+1 Query

**Evidence:** Server Wait is high. You're fetching a list of items, and it's slow proportional to how many items there are.

**How to confirm:** Enable query logging and count the queries. If fetching 50 users fires 51 database queries (1 to get the list, 50 to get each user's data), you have an N+1.

**Fix:** Use JOINs or eager loading. Fetch everything in one query, not one-per-item.

### 3. The Cold Serverless Function

**Evidence:** The first request of the day takes 3 seconds. Subsequent requests take 80 ms. Classic cold start. The function container wasn't running and had to boot up before it could handle the request.

**How to confirm:** Time the first request after a period of inactivity vs. immediate follow-up requests. If there's a huge gap, it's cold starts.

**Fix:** Use provisioned concurrency (AWS Lambda), keep-alive pings, or move latency-sensitive endpoints to a persistent server.

### 4. The Chained Downstream Calls

**Evidence:** Server Wait is high. Your service is healthy. But to respond, it has to call three other services first, and one of them is having a bad day.

**How to confirm:** Add distributed tracing. Look at which downstream call takes the longest. This is where microservices architectures get humbling.

**Fix:** Parallelize calls where possible. Cache responses from slow dependencies. Add timeouts so one slow service doesn't hold up everything.

### 5. The Giant Response

**Evidence:** Server Wait is fast but Content Download is high. The server responded quickly but sent back an enormous payload: 5 MB of JSON for a dashboard that displays 10 numbers.

**How to confirm:** Check the response size in the Network tab. Click the request, look at the Response tab. If you're drowning in data the UI never uses, that's your problem.

**Fix:** Pagination. Field filtering. Only return what the frontend actually needs.

## The cascade problem nobody talks about

Sometimes it's not one slow API call. It's five medium-slow ones that fire sequentially, each one waiting for the previous to finish before starting. The dashboard loads the user, then loads their organisation, then loads their permissions, then loads their settings, then loads their data. Five requests, each 600 ms. Total: 3 seconds.

Individually none of them looks alarming. Together they've killed your UX. This is called a request cascade and it's one of the hardest performance problems to spot because no single request is obviously the culprit.

**How TraceLens catches cascades:** [TraceLens](https://tracelens.site) watches for 3 or more consecutive slow requests and fires a cascade alert automatically. It also groups requests that happen within 800 ms of each other into burst groups, so you can see at a glance that your dashboard load is actually 7 chained requests, not one.

## The checklist when your API is slow

1. **Open the timing waterfall.** Which phase dominates?
2. **Server Wait > 80% of total?** The problem is server-side. Check database queries first.
3. **Download > 50% of total?** The response is too large. Add pagination or field filtering.
4. **DNS or TCP slow?** Infrastructure/geography problem. Consider a CDN or closer region.
5. **Intermittently slow, not always?** Cold starts or resource contention. Check serverless config.
6. **Multiple requests all slow?** Cascade problem. Look for sequential chaining that could be parallelized.

**The golden rule:** the timing waterfall tells you *where* the time went. It doesn't tell you *why*. It's a map that points you to the right room; you still have to find the body yourself.

## FAQ

### How do I find out why my API is slow?

Open Chrome DevTools, then the Network tab, click the slow request, then the Timing tab. Read the waterfall. Server Wait high = database or backend logic problem. Download high = large response. DNS/TCP high = infrastructure/geography problem.

### What is TTFB and why does it matter?

TTFB (Time To First Byte) is how long the server took to start responding. It's the most important number for API performance because it captures all the server-side work (database queries, computation, downstream calls) before a single byte reaches the browser. High TTFB = slow backend. Full stop.

### My API is fast in development but slow in production. Why?

Classic causes: production database has more data (queries that were fast on 100 rows are slow on 10 million), production has different infrastructure (cold serverless functions, different region), or production traffic causes resource contention that didn't exist locally. Always test with production-scale data.

---

The spinner is not a mystery. It's evidence. The timing waterfall is your witness. You just need to know how to ask the right questions.

[TraceLens](https://tracelens.site) is a free Chrome DevTools extension that adds timing waterfall visualization, cascade detection, and automated diagnosis to every request you capture, all inside DevTools, no proxy required. [Open source on GitHub.](https://github.com/Siddharthachuahan9/TRACELENS)

More articles: https://tracelens.site/blog.md
