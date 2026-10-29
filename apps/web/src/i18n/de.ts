/**
 * Every German string the Web_App writes itself (2.1).
 *
 * One `const` object with nested namespaces, so that a key a component asks for either exists with
 * the type the component uses it as, or fails `pnpm check-types`. The point of the module is not
 * translation — there is one language and there will not be a second — but *ownership*: a German
 * literal inside a component is a string nobody can review against a requirement, and 2.1 pins the
 * wording of a dozen of them. Here they sit next to each other, with the requirement that asks for
 * each one named in the comment above it.
 *
 * ## The line against the API_Service
 *
 * The API_Service already owns every German sentence that explains a *failure* or states a *stored
 * value*, and this module restates none of them. That split is not a preference, it is what keeps
 * one sentence from existing twice and drifting:
 *
 * | Text                                                                              | Owner                                                       |
 * | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
 * | Failure of a Scrape_Run, a Platform, an enrichment stage or a write (2.5, 7.4)     | `apps/api/src/common/error-mapping.ts`, over the wire       |
 * | Platform_Status and Run_Outcome labels, the incompleteness hint of 7.4             | `apps/api/src/common/error-mapping.ts`                      |
 * | Best_Commute_Time as a line: "38 Min. (Fahrrad)" / "Erreichbarkeit unbekannt"      | `JobPosting.bestCommuteLabelDe` (8.4, 8.13, 10.1)           |
 * | Relevance_Reason                                                                   | `JobPosting.relevanceReason`, written by the AI_Provider    |
 * | Log_Stream message text                                                            | `LogMessage.messageDe` (12.3)                               |
 * | "A Scrape_Run is already running" and the rejected cancellation                    | `StartScrapeRunPayload.hintDe`, `CancelScrapeRunPayload.rejectedReasonDe` |
 * | The private-use notice of 14.8                                                     | `AppInfo.privateUseNoticeDe`                                |
 * | A resolved Criterion_Field *value* (4.11)                                          | `EffectiveCriterion.valueText`                              |
 *
 * What is left over is what no backend value carries, and that is the whole of this module: labels,
 * headings, button captions, column titles, the option labels of the filters and of the sorting,
 * the empty states of 10.12 and 10.13, the hint 11.6 shows in place of the run counters, the pointer
 * to the Steering_Docs of 4.13, and the two Log_Stream connection texts of 12.11 and 12.12 — which
 * are the Web_App's because the connection breaks in the browser and the server logs nothing about
 * it (see `UNMAPPED_FAILURE_OWNERS` in `error-mapping.ts`).
 *
 * Two kinds of string are deliberately absent:
 *
 * - **Platform_Status and Run_Outcome in German.** `PLATFORM_STATUS_LABELS_DE` and
 *   `RUN_OUTCOME_LABELS_DE` exist in `error-mapping.ts` for the 14-value and the 3-value closed
 *   vocabularies, and a copy here would be a second wording of a list the glossary declares closed.
 *   The run summary of 18.3, the counters of 11.5 and the per-Platform block of 19.1 take the label
 *   from the API_Service — the same way the commute line arrives as `bestCommuteLabelDe`.
 * - **Proper nouns that are not translations.** The product name "Job-Tool" stays in the component
 *   that renders it. The Platform brand spellings below are the one exception and they are here
 *   because they have to be *keyed* by the `Platform` enum value the API sends; "Stepstone" is not a
 *   translation of `STEPSTONE`, it is how the brand is written.
 *
 * ## How a missing key fails the type check
 *
 * Two mechanisms, and both matter:
 *
 * - Every map over a closed vocabulary of `@job-scraper/domain` carries
 *   `satisfies Readonly<Record<X, string>>`, so a missing *or* an extra key is an error in this file.
 *   A fifth Platform or a fifth Relevance_Verdict added to the domain tuples breaks the build here
 *   until it has a German label.
 * - The vocabularies that exist only in the GraphQL schema — reachability, the sort keys, the sort
 *   direction — are `as const` with their literal keys and no annotation, because the authority for
 *   them is the generated enum of task 16.3 and this module must not declare a second value list.
 *   Indexing such a map with a generated enum value is what checks it: a value without a label is a
 *   type error at the component that renders it.
 *
 * The import from `@job-scraper/domain` is **type-only and must stay type-only**: that package
 * reaches `node:crypto` through its content hash helper and `fast-check` through its arbitraries, so
 * a value import would pull both into the browser bundle. `verbatimModuleSyntax` erases the import
 * below entirely.
 *
 * Interpolating entries are functions rather than templates with placeholders, for the same reason:
 * a component that assembled "Seite 2 von 7" from a format string would hold the German word "von".
 *
 * Requirements: 2.1, 2.2, 2.4, 2.5, 2.7, 2.8, 4.12, 4.13, 8.3, 10.1, 10.5, 10.7, 10.9, 10.10,
 * 10.12, 10.13, 10.15, 11.2, 11.5, 11.6, 12.6, 12.11, 12.12, 15.15, 16.8.
 */

import type {
  CriterionField,
  FieldProvenance,
  InterestFlag,
  Platform,
  PostingStatus,
  RelevanceVerdict,
} from '@job-scraper/domain';

/**
 * How each Platform is written where the user sees it.
 *
 * The same spellings as `PLATFORM_LABELS_DE` in `apps/api/src/platform-config/platform-config.messages.ts`,
 * and that is not a duplicated translation: those are brand names, and the API_Service needs them to
 * compose its own German sentences while the Web_App needs them keyed by the enum value it receives
 * in `JobPosting.platform` and offers as a filter option (10.1, 10.5).
 */
const PLATFORM_LABELS = {
  GLASSDOOR: 'Glassdoor',
  JOBVECTOR: 'Jobvector',
  INDEED: 'Indeed',
  STEPSTONE: 'Stepstone',
} as const satisfies Readonly<Record<Platform, string>>;

/** The two Posting_Status values as the overview and the status filter name them (10.1, 10.5). */
const POSTING_STATUS_LABELS = {
  LISTED: 'noch ausgeschrieben',
  NO_LONGER_LISTED: 'nicht mehr ausgeschrieben',
} as const satisfies Readonly<Record<PostingStatus, string>>;

/**
 * The two Interest_Flag values as the marking filter and the marking itself name them (10.5, 10.10).
 *
 * "nicht interessant" is the wording 10.10 and 21.3 use for the action, so the label of the stored
 * state reads the same; the opposite state is named rather than left blank, because the filter needs
 * an option for it.
 */
const INTEREST_FLAG_LABELS = {
  UNMARKED: 'nicht markiert',
  NOT_INTERESTING: 'nicht interessant',
} as const satisfies Readonly<Record<InterestFlag, string>>;

/**
 * The four Relevance_Verdict values as text (10.2, 10.4, 10.5).
 *
 * 10.4 asks for the verdict to be identified by text *in addition to* colour, which is what this map
 * is for: the badge of task 17.1 renders the label, and the colour is decoration on top of it.
 */
const RELEVANCE_VERDICT_LABELS = {
  RELEVANT: 'relevant',
  NOT_RELEVANT: 'nicht relevant',
  UNCERTAIN: 'unsicher',
  NOT_ASSESSED: 'nicht bewertet',
} as const satisfies Readonly<Record<RelevanceVerdict, string>>;

/**
 * The two provenance labels of 4.12, which that criterion spells out literally.
 *
 * The design notes next to `FieldProvenanceEnumRef` that these two strings are the Web_App's, which
 * is why the schema publishes the enum and no label for it.
 */
const FIELD_PROVENANCE_LABELS = {
  DEFAULT: 'aus Standardprofil',
  OVERRIDE: 'überschrieben',
} as const satisfies Readonly<Record<FieldProvenance, string>>;

/**
 * The seven Criterion_Field as the read-only criteria view names them (4.11).
 *
 * `EffectiveCriterion.field` arrives as the English identifier — `searchRadiusKm` — because
 * `CriterionField` is `keyof SearchProfile` and has no value list a GraphQL enum could be registered
 * from, so the published contract leaves the display label to the Web_App. The wording matches
 * `CRITERION_FIELD_LABELS_DE` in the API_Service, which uses it inside the Log_Stream sentences of
 * 4.9 and 4.10; keeping the two identical is deliberate, so the same field is not called two things
 * in the Log_View and in the criteria view.
 */
const CRITERION_FIELD_LABELS = {
  jobTitle: 'Jobtitel',
  titleSynonyms: 'Titel-Synonyme',
  industry: 'Branche',
  searchLocation: 'Suchort',
  searchRadiusKm: 'Suchradius',
  employmentType: 'Anstellungsart',
  publicationPeriodDays: 'Veröffentlichungszeitraum',
} as const satisfies Readonly<Record<CriterionField, string>>;

/**
 * The three reachability classes of the filter of 10.5, which names all three literally.
 *
 * Keyed by the values of the schema's `Reachability` enum. No `satisfies` clause: the value list
 * lives in the API_Service (`REACHABILITIES` in `apps/api/src/posting/posting-page-query.ts`) and
 * reaches the Web_App as a generated enum (task 16.3), so indexing this map with that enum is what
 * checks it rather than a second declaration of the three values here.
 */
const REACHABILITY_LABELS = {
  WELL_REACHABLE: 'gut erreichbar',
  NOT_WELL_REACHABLE: 'nicht gut erreichbar',
  UNKNOWN: 'unbekannt',
} as const;

/** The four sort keys of 10.7, keyed by the schema's `JobPostingSortField` values. */
const SORT_FIELD_LABELS = {
  FIRST_SEEN_AT: 'Erfassungszeit',
  PUBLISHED_AT: 'Veröffentlichungsdatum',
  BEST_COMMUTE_MINUTES: 'Fahrzeit',
  RELEVANCE: 'KI-Bewertung',
} as const;

/** Both directions 10.7 offers for each sort key, keyed by the schema's `SortDirection` values. */
const SORT_DIRECTION_LABELS = {
  ASC: 'aufsteigend',
  DESC: 'absteigend',
} as const;

/**
 * Every German string of the Web_App, by namespace.
 *
 * `as const` throughout: the values are literal types, so a test can assert a pinned wording and a
 * component cannot assign over one.
 */
export const de = {
  /** The shell of the application: landmarks, and the two states 14.8 asks to be shown as text. */
  shell: {
    /** Skip link of 2.3, the first focusable element of every page. */
    skipToContent: 'Zum Hauptinhalt springen',
    mainLandmark: 'Hauptinhalt',
    navigationLandmark: 'Hauptnavigation',
    /** Caption of the link back to the landing page. */
    home: 'Startseite',
    /** Heading above `AppInfo.privateUseNoticeDe`; the notice itself comes from the API_Service. */
    privateUseHeading: 'Hinweis zum Gebrauch',
    /**
     * The activation state of the Relevance_Service (14.8), as text rather than as a colour (2.4).
     *
     * Two whole statements instead of a label plus "ja" / "nein": the user reads one line, and
     * "KI-Bewertung: nein" leaves them to work out what is switched off.
     */
    relevanceServiceActivated:
      'KI-Bewertung ist aktiviert: neue Treffer werden automatisch bewertet.',
    relevanceServiceDeactivated:
      'KI-Bewertung ist deaktiviert: neue Treffer bleiben "nicht bewertet".',
    /** Where the commute determination starts from and what counts as well reachable (8.10). */
    homeAddressLabel: 'Startadresse',
    commuteThresholdLabel: 'Grenze für "gut erreichbar"',
    /** The threshold as a line, so no component holds the unit. */
    commuteThresholdValue: (minutes: number) => `${String(minutes)} Minuten`,
  },

  /** The landing page, whose four controls 2.2 names literally. */
  landing: {
    heading: 'Was möchten Sie tun?',
    startRun: 'Suchlauf starten',
    viewPostings: 'Treffer ansehen',
    viewCriteria: 'Suchkriterien ansehen',
    openLog: 'Log öffnen',
    /**
     * Why "Log öffnen" is blocked while no Scrape_Run has ever run, and what to do about it.
     *
     * The Web_App's own sentence, and one of the few hints that no API_Service value could carry:
     * `activeScrapeRun` and `latestScrapeRun` both answer `null` here and the server words nothing
     * about the absence. The control stays visible as 2.2 requires, so it owes the user a reason —
     * cause plus exactly one next step, which is the same shape as the empty state of 10.12 and for
     * the same situation: nothing has run yet.
     */
    openLogNoRunHint:
      'Es wurde noch kein Suchlauf durchgeführt, deshalb gibt es kein Log zum Öffnen. Starten Sie ' +
      'einen Suchlauf, um den Verlauf mitzulesen.',
  },

  /** The posting overview (10.1 to 10.13, 11.2, 11.5, 11.6). */
  postings: {
    heading: 'Treffer',
    /**
     * Accessible name of the list of 10.1 itself.
     *
     * The list is a table and a table needs a caption, otherwise the only thing naming it is the
     * `h1` of the route — which 2.3 does not accept as a programmatic association. The wording is
     * not a second heading: "Treffer" stands above the whole view including the filter bar and the
     * run summary, while this names the one table the rows sit in.
     */
    listLabel: 'Gespeicherte Treffer',
    /** Column and field titles of the list of 10.1. */
    columns: {
      title: 'Titel',
      employer: 'Arbeitgeber',
      workLocation: 'Arbeitsort',
      platform: 'Plattform',
      publishedAt: 'Veröffentlicht',
      firstSeenAt: 'Erfasst',
      commute: 'Fahrzeit',
      postingStatus: 'Status',
      relevance: 'KI-Bewertung',
      actions: 'Aktionen',
    },
    /**
     * The badges of 17.1. Each is a text label; the symbol next to it carries the alternative text
     * below it, because 2.4 and 11.2 require a state to be recognizable without colour.
     */
    badges: {
      /** The marking of 11.2, which spells the label literally. */
      isNew: 'neu',
      isNewSymbolAlt: 'In diesem Suchlauf erstmals erfasst',
      /** The hint of 8.3 for a Best_Commute_Time at or below the Commute_Threshold. */
      wellReachable: 'gut erreichbar',
      wellReachableSymbolAlt: 'Innerhalb der Fahrzeitgrenze erreichbar',
      /** Where the Relevance_Verdict came from (10.3, 15.15), which 15.15 spells literally. */
      verdictSetManually: 'manuell gesetzt',
      verdictFromService: 'durch KI bewertet',
      /** Heading of the Relevance_Reason the API_Service supplies. */
      relevanceReasonLabel: 'Begründung',
    },
    /** Link into the detail route of 10.8. */
    openDetail: 'Anzeige ansehen',
    /** The Interest_Flag interaction of 10.10. */
    marking: {
      label: 'Markierung',
      mark: 'Als "nicht interessant" markieren',
      withdraw: 'Markierung zurücknehmen',
      /** The confirmation 10.10 asks to be shown within 2 seconds. */
      marked: 'Als "nicht interessant" gespeichert.',
      withdrawn: 'Markierung zurückgenommen.',
      /**
       * What the live region says while the write is in flight (10.10).
       *
       * 10.10 times the confirmation at 2 seconds, and this is what fills that interval: the
       * region the confirmation will appear in says that the write is running, so the user is not
       * left reading the old state after pressing the control. Not `de.common.loading` — that
       * sentence announces data being read, and this is a write the user just triggered.
       */
      saving: 'Markierung wird gespeichert …',
      /**
       * Why a marked Job_Posting is still on the screen, and where it will be afterwards (10.11).
       *
       * The hiding of 10.11 is a filter default on the server, so it takes effect with the next
       * read of the list and not with the write — the row the user just marked stays where it is,
       * which is what keeps the withdrawal of 10.10 reachable. Without this sentence the posting
       * would vanish on the next page change for reasons the user cannot connect to anything, so
       * the hint states both halves: that it will be hidden, and which filter brings it back.
       */
      hiddenHint:
        'Dieser Treffer wird in der Standardansicht ab dem nächsten Laden der Liste ' +
        'ausgeblendet; über den Filter "Markierung" bleibt er sichtbar.',
    },
    /**
     * The manual Relevance_Verdict of 15.15.
     *
     * Captions and field labels only. Three things this namespace deliberately does **not** contain:
     *
     * - **The verdict words.** They are `de.vocabulary.relevanceVerdict`, the one map over the closed
     *   four-value vocabulary, and the three action captions below are built from it rather than
     *   spelling "relevant" a second time.
     * - **A reason to store on the user's behalf.** `JobPosting.relevanceReason` is an API_Service
     *   field written by the AI_Provider (see the ownership table above). A sentence invented here
     *   and written into that column would be the Web_App authoring a stored value, and it would be
     *   shown under "Begründung" forever as though somebody had meant it. The user types their own
     *   words or none at all.
     * - **The German sentence of a refused write.** That arrives from the API_Service.
     */
    verdictControl: {
      heading: 'Bewertung selbst setzen',
      reasonLabel: 'Begründung (optional)',
      /** States both halves: the bound the Posting_Store enforces, and what an empty field means. */
      reasonHint: (maxLength: number): string =>
        `Höchstens ${String(maxLength)} Zeichen. Ohne Eingabe wird keine Begründung gespeichert.`,
      /**
       * Caption of the action per verdict, assembled from the verdict label.
       *
       * A button captioned "relevant" would read as a statement about the Job_Posting rather than as
       * the action of setting that verdict, which is what the user is about to do.
       */
      action: (verdictLabel: string): string => `Als "${verdictLabel}" bewerten`,
      /** What the live region says while the write is in flight, as the marking control does. */
      saving: 'Bewertung wird gespeichert …',
      /** The confirmation, keyed by the verdict the Posting_Store returned rather than the one sent. */
      saved: (verdictLabel: string): string => `Bewertung "${verdictLabel}" gespeichert.`,
    },
    /** The three empty states of 2.8, 10.12 and 10.13. */
    empty: {
      /** No Job_Posting stored at all (10.12), with the call to action that criterion names. */
      storeHeading: 'Noch keine Treffer gespeichert',
      storeHint:
        'Es wurde noch kein Suchlauf durchgeführt, deshalb sind keine Treffer vorhanden. Starten ' +
        'Sie einen Suchlauf, um die Stellenbörsen abzufragen.',
      storeAction: 'Suchlauf starten',
      /** Postings exist, the filter combination matches none (10.13); the filters stay set. */
      filterResultHeading: 'Keine Treffer für diese Filter',
      filterResultHint:
        'Die gesetzten Filter treffen auf keinen gespeicherten Treffer zu. Die Filter bleiben ' +
        'gesetzt; Sie können sie einzeln ändern oder alle zurücksetzen.',
      filterResultAction: 'Filter zurücksetzen',
      /** A Scrape_Run that yielded nothing (2.8), pointing at the read-only criteria view. */
      runWithoutHitsHeading: 'Keine Treffer',
      runWithoutHitsHint:
        'Der Suchlauf hat keine Treffer geliefert. Prüfen Sie als nächsten Schritt die ' +
        'Suchkriterien, mit denen die Stellenbörsen abgefragt wurden.',
      runWithoutHitsAction: 'Suchkriterien ansehen',
    },
    /**
     * The block of 11.5 above the list.
     *
     * Field labels only. The Run_Outcome arrives as a German label from the API_Service, and the
     * three counts arrive as numbers.
     */
    runSummary: {
      heading: 'Letzter abgeschlossener Suchlauf',
      startedAt: 'Beginn',
      finishedAt: 'Ende',
      outcome: 'Ergebnis',
      newPostings: 'Neu erfasst',
      resightedPostings: 'Wieder gesehen',
      totalPostings: 'Insgesamt gespeichert',
      openLog: 'Log dieses Suchlaufs öffnen',
      /** The hint 11.6 asks for *instead of* the counters above. */
      noCompletedRun:
        'Es wurde noch kein Suchlauf abgeschlossen, deshalb gibt es keine Kennzahlen und keine ' +
        'Markierung "neu". Starten Sie einen Suchlauf, um beides zu erhalten.',
    },
  },

  /** The filter bar of 10.5, built as labelled form fields (2.3). */
  filters: {
    heading: 'Filter',
    /** Caption of the control 10.13 names, also usable while the result list is not empty. */
    reset: 'Filter zurücksetzen',
    apply: 'Filter anwenden',
    /**
     * The "all" option of 10.5. One caption for every filter that offers it: the Platform filter
     * defaults to all Platform, and the marking and the Relevance_Verdict filter send their complete
     * value list for it.
     */
    allOption: 'Alle',
    /**
     * Hint on the three filters whose "all" is the absence of a selection (10.5).
     *
     * Platform, reachability and Posting_Status restrict nothing while no value is ticked —
     * "default all Platform" — and an empty group of checkboxes does not say so on its own. The two
     * filters below have their own first option instead, because for them an unticked filter is the
     * default view of 10.6 and 10.11 rather than "all".
     */
    noSelectionHint: 'Ohne Auswahl gelten alle Werte dieses Filters.',
    platform: { label: 'Plattform', options: PLATFORM_LABELS },
    reachability: { label: 'Erreichbarkeit', options: REACHABILITY_LABELS },
    postingStatus: { label: 'Status der Anzeige', options: POSTING_STATUS_LABELS },
    marking: {
      label: 'Markierung',
      /**
       * The state the overview opens in: the default view of 10.11, which hides a Job_Posting
       * marked "nicht interessant". Named as an option of its own because it is neither "Alle" nor
       * one Interest_Flag, and because the user has to be able to come back to it after picking one.
       */
      defaultOption: 'Standardansicht: ohne "nicht interessant"',
      options: INTEREST_FLAG_LABELS,
    },
    relevanceVerdict: {
      label: 'KI-Bewertung',
      /** The same for the default view of 10.6, which hides the Relevance_Verdict "nicht relevant". */
      defaultOption: 'Standardansicht: ohne "nicht relevant"',
      options: RELEVANCE_VERDICT_LABELS,
    },
    /** The recording period of 10.5, a from and a to date. */
    firstSeenPeriod: {
      label: 'Erfassungszeitraum',
      from: 'Von',
      to: 'Bis',
      /** Hint on both date fields, so the expected input is stated rather than guessed. */
      hint: 'Datum im Format TT.MM.JJJJ. Beide Grenzen zählen mit.',
    },
  },

  /** The sorting of 10.7. */
  sort: {
    label: 'Sortierung',
    fieldLabel: 'Sortieren nach',
    directionLabel: 'Richtung',
    fields: SORT_FIELD_LABELS,
    directions: SORT_DIRECTION_LABELS,
  },

  /** The pagination of 10.9. */
  pagination: {
    label: 'Seitennavigation',
    previous: 'Vorherige Seite',
    next: 'Nächste Seite',
    /** The current page number and the total number of pages, which 10.9 asks to be displayed. */
    position: (page: number, totalPages: number) =>
      `Seite ${String(page)} von ${String(totalPages)}`,
    /** How many entries the filtered result list holds in total. */
    totalEntries: (total: number) =>
      total === 1 ? '1 Treffer insgesamt' : `${String(total)} Treffer insgesamt`,
  },

  /** The detail view of 10.8 and 10.15. */
  postingDetail: {
    back: 'Zurück zur Trefferliste',
    descriptionHeading: 'Stellenbeschreibung',
    /** The labelled link to the source URL of 10.8. */
    sourceLink: 'Anzeige auf der Plattform öffnen',
    /** The hint of 10.15; the link stays visible next to it. */
    descriptionMissing:
      'Zu dieser Anzeige wurde kein Beschreibungstext gelesen. Öffnen Sie die Anzeige auf der ' +
      'Plattform, um den vollständigen Text zu lesen.',
    /** A link that no longer resolves to a stored Job_Posting. */
    notFound:
      'Dieser Treffer ist nicht mehr gespeichert. Gehen Sie zurück zur Trefferliste, um die ' +
      'vorhandenen Treffer zu sehen.',
  },

  /** The run controls and the Log_View of 2.7, 12.1 to 12.12. */
  log: {
    heading: 'Log des Suchlaufs',
    open: 'Log öffnen',
    close: 'Log schließen',
    /** Closing the overlay does not stop the Scrape_Run (12.8), so the caption says so. */
    closeHint: 'Der Suchlauf läuft weiter, wenn Sie das Log schließen.',
    /** The two run controls of 12.1 and 12.6, whose captions both criteria name literally. */
    startRun: 'Suchlauf starten',
    cancelRun: 'Suchlauf abbrechen',
    /** Why "Suchlauf starten" is disabled while one runs (2.7). */
    startRunDisabledHint: 'Es läuft bereits ein Suchlauf.',
    /**
     * What the cancellation control says about the *request* it sent (12.6, 12.7).
     *
     * Both are the Web_App's own, and both are deliberately about the request rather than about the
     * Scrape_Run: the shutdown window of 12.7 is what the user is waiting out, and the acceptance of
     * the request is what the button owes them as feedback. What became of the Scrape_Run is the
     * API_Service's to word — the cancellation line in the Log_Stream and the Run_Outcome of the
     * summary — so neither sentence states an outcome, and a rejected cancellation is explained by
     * `CancelScrapeRunPayload.rejectedReasonDe` (12.14).
     */
    cancelRunPending: 'Der Abbruch wird angefordert. Der Suchlauf endet innerhalb von 10 Sekunden.',
    cancelRunAccepted:
      'Der Abbruch wurde angenommen. Das Ergebnis des Suchlaufs steht im Log und in der ' +
      'Zusammenfassung.',
    /** The German status display of 2.7, updated at least every 5 seconds. */
    running: {
      label: 'Suchlauf läuft',
      /** Runtime so far, as minutes and seconds like the summary of 12.10. */
      elapsed: (minutes: number, seconds: number) =>
        `Laufzeit ${String(minutes)} Min. ${String(seconds)} Sek.`,
      /** Progress across the Platform, so the display says something before the first message. */
      platformProgress: (done: number, total: number) =>
        `${String(done)} von ${String(total)} Plattformen abgefragt`,
      waiting: 'Der Suchlauf wurde gestartet. Die ersten Meldungen erscheinen in wenigen Sekunden.',
    },
    /**
     * Accessible name of the message list itself.
     *
     * The list is a table and a table needs a caption, otherwise the only thing naming it is the
     * heading of the overlay — which 2.3 does not accept as a programmatic association. Worded
     * differently from `heading` on purpose: "Log des Suchlaufs" stands above the whole overlay
     * including the controls and the summary, while this names the one table the messages sit in.
     * The same split as `de.postings.heading` and `de.postings.listLabel`.
     */
    messagesLabel: 'Meldungen des Suchlaufs',
    /** Column titles of the message list; the message text itself is `LogMessage.messageDe`. */
    columns: {
      time: 'Zeit',
      platform: 'Plattform',
      message: 'Meldung',
    },
    /** A message that concerns the whole Scrape_Run rather than one Platform. */
    noPlatform: 'Suchlauf',
    /** No message has arrived yet, which is a normal state right after the start. */
    empty: 'Für diesen Suchlauf liegen noch keine Meldungen vor.',
    /**
     * The two Log_Stream connection texts of 12.11 and 12.12.
     *
     * The Web_App's own, not the API_Service's: the connection breaks in the browser and the server
     * logs nothing about it. 12.12 spells the call to action literally.
     */
    connection: {
      interrupted:
        'Die Übertragung der Meldungen ist unterbrochen. Die Verbindung wird automatisch erneut ' +
        'aufgebaut; der Suchlauf läuft unterdessen weiter.',
      reconnecting: (attempt: number, maxAttempts: number) =>
        `Verbindungsversuch ${String(attempt)} von ${String(maxAttempts)}`,
      exhausted:
        'Die Übertragung der Meldungen konnte nicht wiederhergestellt werden. Der Suchlauf läuft ' +
        'weiter. Verbinden Sie die Übertragung erneut, um die Meldungen weiter zu verfolgen.',
      reconnectAction: 'Übertragung erneut verbinden',
    },
    /**
     * The end-of-run summary of 12.10 and 7.4.
     *
     * Field labels and the runtime only. The Run_Outcome, each Platform_Status and the
     * incompleteness hint of 7.4 arrive as German text from the API_Service.
     */
    summary: {
      heading: 'Zusammenfassung des Suchlaufs',
      outcome: 'Ergebnis',
      runtime: 'Laufzeit',
      runtimeValue: (minutes: number, seconds: number) =>
        `${String(minutes)} Min. ${String(seconds)} Sek.`,
      platformHeading: 'Ergebnis je Plattform',
      platformColumns: {
        platform: 'Plattform',
        status: 'Status',
        newPostings: 'Neu',
        updatedPostings: 'Aktualisiert',
      },
      /** Marks a Platform whose result list was not read to the end (7.7). */
      partialResult: 'Teilergebnis',
    },
  },

  /** The read-only view of the search criteria (4.11 to 4.13). */
  criteria: {
    heading: 'Suchkriterien',
    /** States up front that nothing on this page can be changed here (4.13). */
    readOnlyNotice: 'Diese Ansicht zeigt die Suchkriterien unveränderbar an.',
    /**
     * The pointer 4.13 asks for: where the constants live and how a change takes effect.
     *
     * Names the directory rather than a single file, because the Steering_Docs of task 22 are what
     * describe the constants and the restart (16.6).
     */
    changeHint:
      'Die Suchkriterien stehen als Konstanten im Quellcode. Wie sie geändert werden, steht in ' +
      'den Steering-Dokumenten im Verzeichnis .kiro/steering; eine Änderung wirkt nach einem ' +
      'Neustart des Job-Tools.',
    /** One block per supported Platform (4.11). */
    platformHeading: (platformLabel: string) => `Plattform ${platformLabel}`,
    /**
     * Accessible name of the criteria table inside one Platform block.
     *
     * The same split as `de.postings.listLabel` and `de.log.messagesLabel`: the heading above the
     * block names the whole Platform including its status, while this names the one table the
     * resolved criteria sit in. The Platform is in the name because every block has such a table,
     * and a caption repeated four times word for word names none of them.
     */
    tableLabel: (platformLabel: string) => `Aufgelöste Suchkriterien für ${platformLabel}`,
    fieldColumn: 'Kriterium',
    valueColumn: 'Wert',
    provenanceColumn: 'Herkunft',
    /** The two labels of 4.12, exactly one per displayed Criterion_Field. */
    provenance: FIELD_PROVENANCE_LABELS,
    fields: CRITERION_FIELD_LABELS,
    /**
     * Label of the Platform_Status in a Platform block (4.7, 4.9).
     *
     * The label only. The status itself arrives as German text in
     * `PlatformSearchCriteria.platformStatusLabelDe`, and the sentence that explains a deactivated
     * or incompletely configured Platform arrives as `configurationHintDe` — both are the
     * API_Service's, like every other Platform_Status wording (see the table above).
     */
    statusLabel: 'Status',
    /** The missing mandatory field names of 4.10, shown next to the Platform_Status. */
    missingFieldsLabel: 'Fehlende Pflichtfelder',
    /** A Platform with no criteria to show, so the empty table is explained. */
    noCriteria: 'Für diese Plattform werden keine Suchkriterien aufgelöst.',
  },

  /** Labels of the closed vocabularies, wherever they are rendered outside a filter. */
  vocabulary: {
    platform: PLATFORM_LABELS,
    postingStatus: POSTING_STATUS_LABELS,
    interestFlag: INTEREST_FLAG_LABELS,
    relevanceVerdict: RELEVANCE_VERDICT_LABELS,
    reachability: REACHABILITY_LABELS,
    fieldProvenance: FIELD_PROVENANCE_LABELS,
    criterionField: CRITERION_FIELD_LABELS,
  },

  /**
   * The failures the Web_App has to word itself (2.5): cause plus exactly one next step.
   *
   * Every failure the API_Service answers carries its own German sentence, and the Web_App shows
   * that sentence unchanged. What is left are the failures that happen before or outside an answer —
   * no answer at all, and an answer the Web_App could not process.
   */
  errors: {
    /** Heading above any of the messages below, so the state is announced as an error. */
    heading: 'Es ist ein Fehler aufgetreten',
    /** No answer from the API_Service: the Start_Script is the next step, not a reload loop. */
    offline:
      'Das Job-Tool ist nicht erreichbar. Prüfen Sie, ob es über das Startskript gestartet wurde, ' +
      'und laden Sie die Seite anschließend neu.',
    /** Any other failure, including the global error boundary of task 16.5. */
    unexpected:
      'Die Aktion konnte nicht ausgeführt werden. Versuchen Sie es erneut; bleibt der Fehler ' +
      'bestehen, finden Sie die technischen Angaben im Log.',
    /** 2.5 keeps technical detail out of the view and in the Log_View. */
    detailsInLog: 'Technische Angaben stehen im Log.',
    retry: 'Erneut versuchen',
    reload: 'Seite neu laden',
    /** An unknown route; the landing page is the way back to all four functions of 2.2. */
    routeNotFound: 'Diese Seite gibt es nicht. Gehen Sie zur Startseite, um fortzufahren.',
  },

  /** Captions and placeholders shared by more than one view. */
  common: {
    loading: 'Daten werden geladen …',
    /** Placeholder for an optional Job_Posting field the Platform did not supply (6.8). */
    notProvided: 'nicht angegeben',
    close: 'Schließen',
    cancel: 'Abbrechen',
    save: 'Speichern',
  },
} as const;

/** The shape of the German string module, for a component that passes a namespace around. */
export type GermanStrings = typeof de;
