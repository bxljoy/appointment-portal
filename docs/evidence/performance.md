# Production frontend performance

Status: **not measured**. No scores in this file are placeholders or claimed results.

The disposable deployment is measured three times with Lighthouse 13.4.1 using its
mobile profile. The private record binds the exact URL and target path, UTC time,
ready deployed commit, Lighthouse version, mode, profile, run count, and supported
lab metrics. Every run must finish on the exact requested URL; a same-origin sign-in,
callback, error, query, or fragment diversion invalidates the evidence. A public
navigation report supplies three scores, their median, and the exact required FCP,
LCP, Speed Index, TBT, and CLS metric set. An
authenticated appointment report uses a Lighthouse user-flow timespan around managed
reauthentication; it requires the exact TBT and CLS metric set supported by this
timespan and never invents
a navigation performance score. The adapter requires
the exact authenticated appointment heading and sign-out control, so a sign-in view at
`/appointments` cannot be mislabeled as an authenticated measurement.

The public navigation target is median Lighthouse performance **90 or higher**.
Authenticated timespan metrics are diagnostic and have no equivalent score target. These are controlled
lab measurements; they are not field Core Web Vitals or a load-test SLA.
