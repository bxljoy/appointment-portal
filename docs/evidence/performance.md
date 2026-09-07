# Production frontend performance

Status: **not measured**. No scores in this file are placeholders or claimed results.

The disposable deployment is measured three times with Lighthouse 13.4.1 using its
mobile profile. The private record binds the exact URL and target path, UTC time,
ready deployed commit, Lighthouse version, mode, profile, run count, three scores,
median, and available lab metrics. A public navigation report supplies navigation
metrics such as FCP, LCP, Speed Index, TBT, and CLS when Lighthouse reports them. An
authenticated appointment report uses a Lighthouse user-flow snapshot after managed
login; it reports only metrics supported by that user-flow mode. The adapter requires
the exact authenticated appointment heading and sign-out control, so a sign-in view at
`/appointments` cannot be mislabeled as an authenticated measurement.

The target is median Lighthouse performance **90 or higher**. These are controlled
lab measurements; they are not field Core Web Vitals or a load-test SLA.
