# intermittent authored-store startup blocks palette qualification

fresh managed chromium has shown both an explicit `couldn’t open your notes on this device` failure and a separate pending `your notes on this device` presentation before workspace readiness. the causes are unknown; these are not established as one failure.

the public boundary is `apps/web/src/lib/authored/provider.tsx`; store opening belongs to `apps/web/src/lib/authored/client.ts`. identify the actual failure or pending owner from its retained details, repair it there, and qualify the previously blocked fresh-profile journeys with their required storage permission. preserve an explicit environment limit if qualification remains unavailable. later successful startups do not resolve either observation.
