import type { StudioDataSource } from '@mui/x-studio';
import { generateSalesData } from '../salesData/generator.js';

/* eslint-disable no-bitwise, no-plusplus */
// Intentional: mulberry32 PRNG uses bitwise ops for performance; i++ counters are idiomatic.

// ─── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function rng() {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  };
}

type Rng = () => number;

function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7)) - 1;
  const d = Number(dateStr.slice(8, 10));
  return isoDate(new Date(Date.UTC(y, m, d + days)));
}

function zeroPad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function makeDateSampler(from: string, to: string): (rng: Rng) => string {
  const a = new Date(from).getTime();
  const span = new Date(to).getTime() - a;
  return (r) => isoDate(new Date(a + r() * span));
}

// ─── Static vocabulary ────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'James', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'William', 'Sophia',
  'Benjamin', 'Isabella', 'Lucas', 'Mia', 'Henry', 'Charlotte', 'Alexander',
  'Amelia', 'Mason', 'Harper', 'Ethan', 'Evelyn', 'Hans', 'Petra', 'Marie',
  'Pierre', 'Sarah', 'Michael', 'Anna', 'Lars', 'Ingrid', 'Piotr',
] as const;

const LAST_NAMES = [
  'Mueller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Smith', 'Johnson',
  'Williams', 'Brown', 'Jones', 'Martin', 'Bernard', 'Dubois', 'Thomas',
  'Laurent', 'Anderson', 'Taylor', 'Wilson', 'Harris', 'Jackson',
  'Kowalski', 'Nowak', 'Jensen', 'Nielsen', 'Larsson',
] as const;

const ROLES = [
  'CEO', 'CFO', 'CTO', 'VP Sales', 'VP Marketing', 'VP Engineering',
  'Head of Procurement', 'Head of IT', 'Account Manager', 'Sales Director',
  'Procurement Manager', 'IT Manager', 'Finance Director', 'Operations Manager',
  'Business Development Manager',
] as const;

const DEPARTMENTS = [
  'Sales', 'Finance', 'IT', 'Operations', 'Procurement',
  'Marketing', 'Executive', 'Engineering',
] as const;

const DEAL_STAGES = [
  'Prospecting',
  'Qualification',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
] as const;

const DEAL_STAGE_WEIGHTS = [0.2, 0.2, 0.2, 0.15, 0.15, 0.1] as const;

const ACTIVITY_TYPES = ['Call', 'Email', 'Meeting', 'Demo', 'Follow-up'] as const;

const ACTIVITY_OUTCOMES = [
  'Positive',
  'Neutral',
  'Needs follow-up',
  'No response',
  'Declined',
] as const;

// ─── Source IDs ───────────────────────────────────────────────────────────────

export const CRM_CONTACTS_SOURCE_ID = 'source-crm-contacts';
export const CRM_DEALS_SOURCE_ID = 'source-crm-deals';
export const CRM_ACTIVITIES_SOURCE_ID = 'source-crm-activities';

// ─── Generator options ────────────────────────────────────────────────────────

export interface CrmGeneratorOptions {
  /**
   * Integer seed for the PRNG. Must match the seed used for `generateSalesData`
   * so customer IDs are identical. Default: 42.
   */
  seed?: number;
  /**
   * Number of orders (same as in generateSalesData). Used to derive the
   * customer count so company references always match. Default: 220.
   */
  orderCount?: number;
}

export interface GeneratedCrmData {
  contactsSource: StudioDataSource;
  dealsSource: StudioDataSource;
  activitiesSource: StudioDataSource;
}

// ─── Individual table generators ─────────────────────────────────────────────

interface GeneratedContact extends Record<string, unknown> {
  id: string;
  customerId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: string;
  department: string;
}

function generateContacts(rng: Rng, customerRows: Record<string, unknown>[]): {
  source: StudioDataSource;
  rows: GeneratedContact[];
  byCustomerId: Map<string, GeneratedContact[]>;
} {
  const rows: GeneratedContact[] = [];
  const byCustomerId = new Map<string, GeneratedContact[]>();
  let contactIdx = 1;

  for (const customer of customerRows) {
    const customerId = customer.id as string;
    const company = (customer.company as string).toLowerCase().replace(/\s+/g, '');
    const count = randInt(rng, 2, 4);
    const customerContacts: GeneratedContact[] = [];

    for (let j = 0; j < count; j++) {
      const firstName = pick(rng, FIRST_NAMES);
      const lastName = pick(rng, LAST_NAMES);
      const contact: GeneratedContact = {
        id: `CON-${zeroPad(contactIdx, 4)}`,
        customerId,
        firstName,
        lastName,
        email: `${firstName.toLowerCase().charAt(0)}.${lastName.toLowerCase()}@${company}.com`,
        phone: `+${randInt(rng, 1, 99)}-${randInt(rng, 100, 999)}-${randInt(rng, 1000000, 9999999)}`,
        role: pick(rng, ROLES),
        department: pick(rng, DEPARTMENTS),
      };
      rows.push(contact);
      customerContacts.push(contact);
      contactIdx++;
    }

    byCustomerId.set(customerId, customerContacts);
  }

  return {
    source: {
      id: CRM_CONTACTS_SOURCE_ID,
      label: 'CRM Contacts',
      tableName: 'contacts',
      fields: [
        { id: 'id', label: 'Contact ID', type: 'string', hidden: true },
        { id: 'customerId', label: 'Company ID', type: 'string', hidden: true },
        { id: 'firstName', label: 'First Name', type: 'string' },
        { id: 'lastName', label: 'Last Name', type: 'string' },
        { id: 'email', label: 'Email', type: 'string' },
        { id: 'phone', label: 'Phone', type: 'string' },
        { id: 'role', label: 'Role', type: 'string' },
        { id: 'department', label: 'Department', type: 'string' },
      ],
      rows,
    },
    rows,
    byCustomerId,
  };
}

interface GeneratedDeal extends Record<string, unknown> {
  id: string;
  customerId: string;
  title: string;
  stage: string;
  value: number;
  probability: number;
  openedDate: string;
  closeDate: string;
}

function pickWeighted<T>(rng: Rng, options: readonly T[], weights: readonly number[]): T {
  const r = rng();
  let cumulative = 0;
  for (let i = 0; i < options.length; i++) {
    cumulative += weights[i];
    if (r < cumulative) {
      return options[i];
    }
  }
  return options[options.length - 1];
}

const DEAL_TITLE_TEMPLATES = [
  'Enterprise License Renewal',
  'Software Upgrade Package',
  'Hardware Refresh Initiative',
  'Cloud Migration Project',
  'IT Support Contract',
  'Network Infrastructure Upgrade',
  'Security Suite Deployment',
  'Annual Maintenance Agreement',
  'Professional Services Engagement',
  'Digital Transformation Package',
] as const;

function generateDeals(
  rng: Rng,
  customerRows: Record<string, unknown>[],
  byCustomerId: Map<string, GeneratedContact[]>,
): { source: StudioDataSource; rows: GeneratedDeal[]; byDealId: Map<string, GeneratedDeal> } {
  const rows: GeneratedDeal[] = [];
  const byDealId = new Map<string, GeneratedDeal>();
  let dealIdx = 1;

  const today = new Date();
  const twoYearsAgo = new Date(today);
  twoYearsAgo.setFullYear(today.getFullYear() - 2);
  const oneYearAhead = new Date(today);
  oneYearAhead.setFullYear(today.getFullYear() + 1);

  const sampleOpenedDate = makeDateSampler(isoDate(twoYearsAgo), isoDate(today));

  for (const customer of customerRows) {
    const customerId = customer.id as string;
    const dealCount = randInt(rng, 0, 3);

    for (let j = 0; j < dealCount; j++) {
      const stage = pickWeighted(rng, DEAL_STAGES, DEAL_STAGE_WEIGHTS);
      const value = Math.round(randInt(rng, 5000, 250000) / 500) * 500;
      const probability =
        stage === 'Closed Won' ? 100
        : stage === 'Closed Lost' ? 0
        : stage === 'Negotiation' ? randInt(rng, 60, 80)
        : stage === 'Proposal' ? randInt(rng, 40, 60)
        : stage === 'Qualification' ? randInt(rng, 20, 40)
        : randInt(rng, 5, 20);

      const openedDate = sampleOpenedDate(rng);
      const closeDate = addDays(openedDate, randInt(rng, 30, 180));

      // Assign primary contact from this company (first one if available)
      const contacts = byCustomerId.get(customerId) ?? [];
      const primaryContactId = contacts.length > 0 ? contacts[0].id : null;

      const deal: GeneratedDeal = {
        id: `DEAL-${zeroPad(dealIdx, 5)}`,
        customerId,
        primaryContactId,
        title: pick(rng, DEAL_TITLE_TEMPLATES),
        stage,
        value,
        probability,
        openedDate,
        closeDate,
      };

      rows.push(deal);
      byDealId.set(deal.id, deal);
      dealIdx++;
    }
  }

  return {
    source: {
      id: CRM_DEALS_SOURCE_ID,
      label: 'CRM Deals',
      tableName: 'deals',
      fields: [
        { id: 'id', label: 'Deal ID', type: 'string', hidden: true },
        { id: 'customerId', label: 'Company ID', type: 'string', hidden: true },
        { id: 'primaryContactId', label: 'Contact ID', type: 'string', hidden: true },
        { id: 'title', label: 'Deal Title', type: 'string' },
        { id: 'stage', label: 'Stage', type: 'string' },
        { id: 'value', label: 'Deal Value', type: 'number', format: 'currency' },
        { id: 'probability', label: 'Probability', type: 'number', format: 'percent' },
        { id: 'openedDate', label: 'Opened', type: 'date' },
        { id: 'closeDate', label: 'Close Date', type: 'date' },
      ],
      rows,
    },
    rows,
    byDealId,
  };
}

interface GeneratedActivity extends Record<string, unknown> {
  id: string;
  contactId: string;
  dealId: string | null;
  type: string;
  date: string;
  outcome: string;
  durationMin: number;
}

function generateActivities(
  rng: Rng,
  deals: GeneratedDeal[],
  byCustomerId: Map<string, GeneratedContact[]>,
): StudioDataSource {
  const rows: GeneratedActivity[] = [];
  let actIdx = 1;

  const today = new Date();
  const twoYearsAgo = new Date(today);
  twoYearsAgo.setFullYear(today.getFullYear() - 2);
  const sampleDate = makeDateSampler(isoDate(twoYearsAgo), isoDate(today));

  for (const deal of deals) {
    const contacts = byCustomerId.get(deal.customerId) ?? [];
    if (contacts.length === 0) {
      continue;
    }
    const activityCount = randInt(rng, 1, 5);
    for (let j = 0; j < activityCount; j++) {
      const contact = pick(rng, contacts);
      rows.push({
        id: `ACT-${zeroPad(actIdx, 5)}`,
        contactId: contact.id,
        dealId: deal.id,
        type: pick(rng, ACTIVITY_TYPES),
        date: sampleDate(rng),
        outcome: pick(rng, ACTIVITY_OUTCOMES),
        durationMin: randInt(rng, 15, 90),
      });
      actIdx++;
    }
  }

  return {
    id: CRM_ACTIVITIES_SOURCE_ID,
    label: 'CRM Activities',
    tableName: 'activities',
    fields: [
      { id: 'id', label: 'Activity ID', type: 'string', hidden: true },
      { id: 'contactId', label: 'Contact ID', type: 'string', hidden: true },
      { id: 'dealId', label: 'Deal ID', type: 'string', hidden: true },
      { id: 'type', label: 'Type', type: 'string' },
      { id: 'date', label: 'Date', type: 'date' },
      { id: 'outcome', label: 'Outcome', type: 'string' },
      { id: 'durationMin', label: 'Duration (min)', type: 'number', format: 'integer' },
    ],
    rows,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate a coherent set of CRM data sources whose company IDs (`customerId`)
 * match those produced by `generateSalesData` with the same `seed` and `orderCount`.
 *
 * CRM tables: contacts, deals, activities.
 *
 * @param opts.seed - Integer seed. Must match the seed used for `generateSalesData`. Default: 42.
 * @param opts.orderCount - Number of orders (determines customer count). Default: 220.
 */
export function generateCrmData(opts?: CrmGeneratorOptions): GeneratedCrmData {
  const seed = opts?.seed ?? 42;
  const orderCount = opts?.orderCount ?? 220;

  // Re-generate customers using the same seed so CUS-xxx IDs and company names match.
  // This is a pure reproduction — no side effects on the sales PRNG.
  const { customersSource } = generateSalesData({ seed, orderCount });
  const customerRows = customersSource.rows ?? [];

  // CRM PRNG is seeded at seed + 1_000_000 to avoid any overlap with the sales PRNG sequence.
  const rng = mulberry32(seed + 1_000_000);

  const { source: contactsSource, byCustomerId } = generateContacts(rng, customerRows);
  const { source: dealsSource, rows: dealRows, byDealId: _ } = generateDeals(
    rng,
    customerRows,
    byCustomerId,
  );
  const activitiesSource = generateActivities(rng, dealRows, byCustomerId);

  return { contactsSource, dealsSource, activitiesSource };
}
