# Production frontend performance

Status: **not measured**. No scores in this file are placeholders or claimed results.

The disposable deployment is measured three times with Lighthouse 13.4.1 using its
mobile profile. Record the exact URL, UTC time, deployed commit, three scores, median,
and lab metrics. A public navigation report supplies Lighthouse navigation metrics.
An authenticated appointment-route report must use an injected Lighthouse user-flow
adapter that preserves an active in-memory session or explicitly signs in for each
run. It must reject any final sign-in, callback, or signed-out URL.

The target is median Lighthouse performance **90 or higher**. These are controlled
lab measurements; they are not field Core Web Vitals or a load-test SLA.
