## Generic Dental AI Reception Agent

A real-time AI voice reception agent, now built to be reusable across any dental clinic. It handles inbound calls: greeting callers, understanding what treatment/appointment they need, collecting name & phone number, confirming details, and logging the lead for the front-desk team to follow up — 24/7.

### How to demo for a new clinic

Edit **`clinic.json`** only — every other file reads from it automatically via the `/api/clinic` endpoint:

```json
{
  "name": "Clinic Name",
  "location": "City",
  "website": "clinicwebsite.com",
  "phone": "phone number",
  "practices": "description of practice locations/specialties",
  "hours": "opening hours",
  "services": "comma-separated list of services offered",
  "offer": "any promo offer",
  "rating": "review/rating line",
  "avatarLetter": "first letter shown in the UI avatar"
}
```

Reset `leads.json` to `[]` before each new demo to start with a clean dashboard.

Then run:
```
npm install
npm start
```

Visit `/` for the dashboard and `/call.html` to talk to the AI receptionist.
