/* Lucid Slides — the ADHD focus rules the optimizer applies.
 *
 * Rules 1-6, 8-10 and 12 are text rules: they can be applied automatically by
 * rewriting a paragraph's wording or emphasising a few key words.
 * Rules 7 and 11 describe animation/reveal behaviour, which cannot be authored
 * safely from the browser, so they are never proposed as automatic edits.
 */

export const RULES = [
  {
    n: 1,
    title: "One idea per line",
    guidance: "Each line carries a single idea. Split or drop anything that stacks two ideas into one line.",
    automatic: true,
  },
  {
    n: 2,
    title: "Short, concrete titles",
    guidance: "Titles state the takeaway in 8 words or fewer. Cut throat-clearing like 'An overview of' or 'Introduction to'.",
    automatic: true,
  },
  {
    n: 3,
    title: "Short lines",
    guidance: "Body lines run about 10 words or fewer. Compress sentences into scannable phrases; drop filler clauses.",
    automatic: true,
  },
  {
    n: 4,
    title: "Sparse emphasis",
    guidance: "Bold only the few words that carry the meaning — well under a fifth of the line. Never bold a whole line.",
    automatic: true,
  },
  {
    n: 5,
    title: "Plain language",
    guidance: "Replace jargon, acronyms and abstract nouns with everyday words a distracted reader gets on the first pass.",
    automatic: true,
  },
  {
    n: 6,
    title: "Active voice",
    guidance: "Use active voice and concrete verbs. Turn 'utilisation of X occurs' into 'we use X'.",
    automatic: true,
  },
  {
    n: 7,
    title: "Progressive reveal",
    guidance: "Reveal bullets one at a time so attention lands on one line. Requires manual animation work in PowerPoint.",
    automatic: false,
  },
  {
    n: 8,
    title: "Charts state their point",
    guidance: "A chart's caption states the conclusion, not the variable names.",
    automatic: true,
  },
  {
    n: 9,
    title: "Parallel phrasing",
    guidance: "Bullets in one list share a grammatical shape so the eye can pattern-match down the list.",
    automatic: true,
  },
  {
    n: 10,
    title: "No redundancy",
    guidance: "Drop words already carried by the title or the previous line. Never repeat the title inside a bullet.",
    automatic: true,
  },
  {
    n: 11,
    title: "Calm motion",
    guidance: "Avoid decorative transitions and looping motion. Requires manual animation work in PowerPoint.",
    automatic: false,
  },
  {
    n: 12,
    title: "Concrete numbers",
    guidance: "Round numbers and attach a unit or comparison so they can be grasped at a glance.",
    automatic: true,
  },
];

export const AUTOMATIC_RULES = RULES.filter((rule) => rule.automatic).map((rule) => rule.n);

export const RULE_TITLES = Object.fromEntries(RULES.map((rule) => [rule.n, rule.title]));

export function ruleGuidanceText() {
  return RULES
    .filter((rule) => rule.automatic)
    .map((rule) => `Rule ${rule.n} — ${rule.title}: ${rule.guidance}`)
    .join("\n");
}
