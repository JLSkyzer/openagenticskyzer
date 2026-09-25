// Required (for its side effect) by the test helpers and by the tests that use none: every test starts on an
// empty data directory, where the first-launch wizard would cover the interface they drive. The worker reads
// this variable (worker.mjs::appGlobalSettings) and reports the wizard as done without writing anything.
// The wizard's OWN tests delete it right after requiring their helpers.
process.env.OPENAGENT_SKIP_ONBOARDING = '1';
