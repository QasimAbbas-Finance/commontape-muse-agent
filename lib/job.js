// The job the agent understood, written as the exact body of a CommonTape search (POST /api/v1/search).
// Words from CommonTape's public word list, GET /api/v1/taxonomy/house_cleaning (version 6, read 26 Oct 2026).

export const SERVICES = ["house_cleaning.standard", "house_cleaning.deep", "house_cleaning.move_in_out"];

export const HOME_TYPES = [
  "property.studio", "property.apartment", "property.condo", "property.townhouse",
  "property.detached_house", "property.duplex", "property.villa", "property.other_residential",
];

const ROOMS = { bedrooms: "space.bedroom", full_bathrooms: "space.bathroom.full", half_bathrooms: "space.bathroom.half" };
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export class JobError extends Error {}

// job: { zip, service_key?, home_type?, bedrooms?, full_bathrooms?, half_bathrooms?, max_total?, arrive_by?, finish_by? }
// Only the facts the customer gave go in, so the body can be replayed against CommonTape as it is.
export function searchBody(job) {
  if (typeof job !== "object" || job === null) throw new JobError("There is no job to search for.");
  const zip = String(job.zip ?? "").trim();
  if (!/^\d{5}$/.test(zip)) throw new JobError("A 5-digit US ZIP code is needed.");
  const service = job.service_key ?? "house_cleaning.standard";
  if (!SERVICES.includes(service)) throw new JobError(`CommonTape has no service called ${service}.`);
  const body = { zip, service_key: service };

  const property = {};
  if (job.home_type != null) {
    if (!HOME_TYPES.includes(job.home_type)) throw new JobError(`CommonTape has no home type called ${job.home_type}.`);
    property.type = job.home_type;
  }
  const spaces = {};
  for (const [field, key] of Object.entries(ROOMS)) {
    if (job[field] == null) continue;
    if (!Number.isInteger(job[field]) || job[field] < 0 || job[field] > 20) throw new JobError(`${field} must be a whole number from 0 to 20.`);
    spaces[key] = job[field];
  }
  if (Object.keys(spaces).length) property.spaces = spaces;
  if (Object.keys(property).length) body.property = property;

  if (job.max_total != null) {
    if (typeof job.max_total !== "number" || !(job.max_total > 0)) throw new JobError("The budget must be a number of dollars above 0.");
    body.max_total = job.max_total;
  }
  for (const field of ["arrive_by", "finish_by"]) {
    if (job[field] == null) continue;
    if (typeof job[field] !== "string" || !WALL_CLOCK.test(job[field])) throw new JobError(`${field} must be a date and time like 2026-11-02T10:00.`);
    body[field] = job[field];
  }
  return body;
}
