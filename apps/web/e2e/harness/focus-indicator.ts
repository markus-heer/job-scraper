/**
 * The focus-indicator and keyboard-traversal measurement of Requirement 2.3 (task 21.5).
 *
 * ```ts
 * const stops = await walkTabOrder(page);
 *
 * expectFocusIndicators(stops, 'landing: no Scrape_Run has ever run');
 * ```
 *
 * 2.3 pins four properties. `./accessibility.ts` reaches three of them through axe and says in its
 * own header which one it cannot reach: **the control currently in focus carries a visible focus
 * indicator with a contrast ratio of at least 3 : 1 against the background.** No axe rule decides
 * it, because axe measures no element in its focused state. This module is that measurement, and
 * the spec that uses it is `../focus-and-keyboard.spec.ts`.
 *
 * ## How the measurement works
 *
 * Tab, measure, repeat. Nothing is focused programmatically: `:focus-visible` is the selector the
 * shell declares its ring on, and Chromium matches it for a focus that came from the keyboard while
 * it may skip it for a bare `element.focus()`. Measuring a control that was focused by script would
 * therefore measure a state the user never sees, in either direction — a missing ring that is
 * really there, or a ring that is really absent. So the walk presses Tab, and every measurement is
 * of the element the browser itself decided to focus next.
 *
 * Per stop, {@link FocusStop} records:
 *
 * - `isFocusVisible` — whether the focused element matches `:focus-visible` at that moment, which is
 *   the condition the shell's rule is keyed on;
 * - the resolved `outline-style`, `outline-width`, `outline-offset` and `outline-color` of the
 *   focused element, plus the same four as they stand **without** focus (read in one pass before the
 *   walk begins), so "an indicator appeared" is a comparison rather than an assumption;
 * - `surface` — the colour painted directly behind the ring, composited;
 * - `contrastRatio` — the WCAG 2.1 relative-luminance ratio of the ring colour against that surface;
 * - `overlappingSurfaces` — every element that is *not* an ancestor of the focused control, carries
 *   a painted background and whose box reaches into the ring band, each with its own ratio;
 * - where the control sits in the viewport, and whether it is inside it.
 *
 * ### Which surface the ring is measured against
 *
 * `outline-offset: 2px` in `src/styles/shell.css` puts the whole ring outside the control's border
 * box, so the pixels of the ring lie on whatever is painted behind the *parent*, not on the control
 * itself. The walk therefore composites from the focused element's parent outwards — each
 * `background-color` over the next, stopping at the first fully opaque layer — and measures against
 * that. Where `outline-offset` is negative the ring lies over the control's own background instead,
 * and the composite then starts at the element itself; the stop records which of the two it was in
 * `surface.source`.
 *
 * That model has one hole, and it is closed rather than noted: a *sibling* with a painted background
 * may overlap the few pixels of the ring band, and an ancestor walk cannot see it. Every such
 * element is collected per stop and measured too, so a ring that lands on a badge surface is
 * measured against that badge. The overlay backdrop of the Log_View is deliberately not among them —
 * it is an ancestor of the dialog, and the dialog's opaque white is painted over it, which is
 * exactly what the nearest-opaque-ancestor composite expresses.
 *
 * The collection is geometric and knows nothing about paint order, which is a deliberate bias in one
 * direction: in the Log_View it reports the private-use notice of the route *underneath* the overlay,
 * because that box does reach into the ring band even though two layers are painted over it. A
 * surface that is not really visible can therefore add a constraint that is not really there — it can
 * make this measurement fail on something harmless, and it can never make it pass on something real.
 * A conservative check is the right way round for a criterion nothing else checks at all.
 *
 * ## What the measurement establishes, and what it does not
 *
 * It establishes: the focused control resolves an outline that the unfocused control does not, and
 * the colour the browser resolved for that outline stands at 3 : 1 or better against the colour the
 * browser resolved for the surface the ring is painted on — computed with the relative-luminance
 * formula of WCAG 2.1, not approximated and not asserted as "an outline exists".
 *
 * It does **not** establish:
 *
 * - **That the rendered pixels are those colours.** The reads are resolved computed values, not a
 *   screenshot. A `background-image`, a gradient or a filter over the surface would change the
 *   pixels without changing `background-color`, so the walk records whether any layer of the
 *   composite carries a `background-image` and the assertion refuses to pass a surface that does —
 *   it reports the surface as unmeasurable instead of quietly measuring the wrong thing.
 * - **The size or the shape of the indicator.** WCAG 2.1 level AA has no such criterion (the area
 *   rules arrived with 2.4.13 in WCAG 2.2) and 2.3 names none, so the width is reported rather than
 *   asserted beyond being non-zero.
 * - **Anything about a control outside the tab order.** The walk sees what Tab reaches in the state
 *   it is run in. A control behind a state this suite cannot produce — the "Suchlauf abbrechen" of a
 *   *running* Scrape_Run, for one, for the reason `./accessibility.ts` gives — is not measured, and
 *   `../focus-and-keyboard.spec.ts` lists what that leaves out.
 * - **That focus is visible on the element the skip link lands on.** `.app-shell__main` carries
 *   `tabindex="-1"` and `outline: none`, deliberately: it is a landmark, not a control, and 2.3 ties
 *   the indicator to "the control currently in focus". Tab never reaches it, so the walk never
 *   measures it.
 *
 * ## The form-field half
 *
 * {@link readFormFieldLabels} is the second measurement here, and it exists because axe's `label`
 * rule and 2.3 do not ask the same question. axe passes a field whose whole name comes from
 * `aria-label` — nothing visible on the screen — while 2.3 asks for "a visible label
 * programmatically associated with the field". So the read collects, per field, every label element
 * that is associated with it (native `labels`, `aria-labelledby`, the `legend` of its `fieldset`)
 * and whether that element is actually rendered, and flags a field whose name comes from an
 * attribute alone. It stops short of computing the accessible name per the accname specification:
 * what it asserts is that a rendered, associated, non-empty label exists, not that it is the whole
 * name.
 *
 * Requirements: 2.2, 2.3.
 */

import { expect, type Page, test } from '@playwright/test';

/** The ratio Requirement 2.3 demands of the focus indicator against the background. */
export const MINIMUM_FOCUS_CONTRAST = 3;

/**
 * Everything the browser may put in the tab order.
 *
 * Wider than the tab order on purpose: it is used to give each stop a stable position, so it has to
 * contain every element Tab can reach. Elements it contains that Tab *cannot* reach — a `disabled`
 * button, `tabindex="-1"` — simply never turn up as the active element.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[tabindex]',
  '[contenteditable="true"]',
].join(', ');

/** How many Tab presses a walk performs before it treats the tab order as unbounded. */
const DEFAULT_MAX_STOPS = 250;

/**
 * How many consecutive Tab presses may stay on one element before the walk gives up on it.
 *
 * Chromium's `input[type=date]` is three tab stops in one element — day, month, year — and
 * `input[type=datetime-local]` is seven. Eight therefore clears every segmented control the
 * platform has while still ending a walk that is stuck on one control.
 */
const MAX_INTERNAL_TAB_STOPS = 8;

/** A colour as the browser resolved it, with its alpha kept separate. */
export interface Rgba {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  /** 0 to 1. A fully transparent colour paints nothing, whatever its channels say. */
  readonly alpha: number;
}

/** The outline of one element, as the browser resolved it. */
export interface OutlineStyle {
  readonly style: string;
  readonly widthPx: number;
  readonly offsetPx: number;
  readonly colour: string;
  /** Everything else that could draw an indicator, kept so a changed ring is recognisable. */
  readonly boxShadow: string;
  readonly borderColour: string;
}

/** The colour painted behind the focus ring, and where it came from. */
export interface RingSurface {
  /**
   * `'parent'` where `outline-offset` puts the ring outside the control's box, which is the normal
   * case, and `'self'` where a negative offset puts it over the control's own background.
   */
  readonly source: 'parent' | 'self';
  /** The composite, nearest layer first, each as the browser resolved it. */
  readonly layers: readonly string[];
  /** A readable path to the element whose background ended the composite. */
  readonly element: string;
  /** True where no layer of the composite was opaque and the white page canvas was assumed. */
  readonly assumedCanvas: boolean;
  /** Any `background-image` on a layer of the composite; a non-empty list makes it unmeasurable. */
  readonly backgroundImages: readonly string[];
}

/** An element that is no ancestor of the focused control but reaches into its ring band. */
export interface OverlappingSurface {
  readonly element: string;
  readonly colour: string;
  readonly contrastRatio: number;
}

/** One stop of the tab order, measured while it held the focus. */
export interface FocusStop {
  /** 1-based, in the order Tab reached them. */
  readonly position: number;
  /** The element, as `button «Suchlauf starten»`. */
  readonly label: string;
  /** Its position in the document's focusable elements, which is how the walk identifies it. */
  readonly focusableIndex: number;
  /** Whether the element matched `:focus-visible` — the selector the shell's ring is keyed on. */
  readonly isFocusVisible: boolean;
  readonly focused: OutlineStyle;
  /** The same element's outline without focus, read before the walk; `null` when not found. */
  readonly unfocused: OutlineStyle | null;
  readonly surface: RingSurface;
  /** The ring colour composited over {@link surface}, which is what the ratio is computed from. */
  readonly ringColour: string;
  /** The WCAG 2.1 ratio of the ring colour against the surface behind it. */
  readonly contrastRatio: number;
  readonly overlappingSurfaces: readonly OverlappingSurface[];
  /** Where the control stands, in CSS pixels relative to the viewport. */
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Whether the whole control is inside the viewport, which is what scrolling it into view means. */
  readonly isInViewport: boolean;
}

/** One form field and the label elements associated with it. */
export interface FormFieldLabel {
  /** The field, as `input[type=checkbox]#platform-STEPSTONE`. */
  readonly field: string;
  /** Every associated label element, native or by `aria-labelledby`. */
  readonly labels: readonly {
    readonly kind: 'label' | 'aria-labelledby' | 'legend';
    readonly text: string;
    readonly isRendered: boolean;
  }[];
  /** True where the field's name can only come from `aria-label` or `title` — what 2.3 rules out. */
  readonly namedByAttributeOnly: boolean;
}

/* -------------------------------------------------------------- colour maths */

/** `rgb()` and `rgba()` in both the legacy comma form and the space form Chromium also emits. */
const RGB_PATTERN =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/u;

/**
 * One resolved CSS colour as numbers.
 *
 * @throws An `Error` for anything that is not `transparent`, `rgb()` or `rgba()`. Deliberate: a
 *   colour this cannot read is a colour the ratio below would be wrong about, and a measurement that
 *   guessed would report a pass it has not established.
 */
export const parseCssColour = (css: string): Rgba => {
  const value = css.trim();

  if (value === 'transparent') {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }

  const parts = RGB_PATTERN.exec(value);

  if (parts === null) {
    throw new Error(
      `The colour ${JSON.stringify(css)} is not in a form this measurement can read. Only ` +
        '`transparent`, `rgb()` and `rgba()` are, which is what Chromium resolves a hex or named ' +
        'colour to. A colour function such as `oklch()` would need the conversion added here ' +
        'rather than approximated.',
    );
  }

  const alpha = parts[4] ?? '1';

  return {
    red: Number(parts[1]),
    green: Number(parts[2]),
    blue: Number(parts[3]),
    alpha: alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha),
  };
};

/** `front` painted over `back`, which is how a translucent layer becomes a colour. */
export const compositeOver = (front: Rgba, back: Rgba): Rgba => {
  const alpha = front.alpha + back.alpha * (1 - front.alpha);

  if (alpha === 0) {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }

  const blend = (frontChannel: number, backChannel: number): number =>
    (frontChannel * front.alpha + backChannel * back.alpha * (1 - front.alpha)) / alpha;

  return {
    red: blend(front.red, back.red),
    green: blend(front.green, back.green),
    blue: blend(front.blue, back.blue),
    alpha,
  };
};

/** The relative luminance of WCAG 2.1, which is what a contrast ratio is built from. */
export const relativeLuminance = ({ red, green, blue }: Rgba): number => {
  const channel = (value: number): number => {
    const scaled = value / 255;

    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
};

/**
 * The contrast ratio of two opaque colours, as WCAG 2.1 defines it: 1 for identical colours, 21 for
 * black against white.
 */
export const contrastRatio = (one: Rgba, other: Rgba): number => {
  const first = relativeLuminance(one);
  const second = relativeLuminance(other);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);

  return (lighter + 0.05) / (darker + 0.05);
};

/** The white page canvas, which is what an unterminated background composite ends on. */
const CANVAS_WHITE: Rgba = { red: 255, green: 255, blue: 255, alpha: 1 };

/** A stack of resolved background colours, nearest first, as one opaque colour. */
const compositeLayers = (layers: readonly string[]): Rgba =>
  [...layers]
    .reverse()
    .reduce<Rgba>((below, layer) => compositeOver(parseCssColour(layer), below), CANVAS_WHITE);

/* ------------------------------------------------------- the browser-side read */

/** What the browser reports about the element that currently holds the focus. */
interface ActiveElementReport {
  readonly label: string;
  readonly focusableIndex: number;
  readonly isFocusVisible: boolean;
  readonly outline: OutlineStyle;
  readonly surface: RingSurface;
  readonly overlapping: readonly { readonly element: string; readonly layers: readonly string[] }[];
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly isInViewport: boolean;
}

/**
 * Reads the focused element, or `null` where the focus has left the document.
 *
 * Everything this needs is inlined, because the function body is serialised into the page and can
 * reach nothing from this module.
 */
const readActiveElement = async (page: Page): Promise<ActiveElementReport | null> =>
  page.evaluate((focusableSelector: string) => {
    const active = document.activeElement;

    if (active === null || active === document.body || active === document.documentElement) {
      return null;
    }

    /** `button «Suchlauf starten»`, which is what a failure message has to name. */
    const describe = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const type = element.getAttribute('type');
      const identifier = element.id === '' ? '' : `#${element.id}`;
      // `getAttribute` rather than `className`, which is not a string on an SVG element and would
      // throw on `split` — and this describer runs over every element of the document.
      const classNames = (element.getAttribute('class') ?? '').trim();
      const classes = classNames === '' ? '' : `.${classNames.split(/\s+/u).join('.')}`;
      const text = (element.getAttribute('aria-label') ?? element.textContent ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 60);
      const shape = `${tag}${type === null ? '' : `[type=${type}]`}${identifier}${identifier === '' ? classes : ''}`;

      return text === '' ? shape : `${shape} «${text}»`;
    };

    const styleOf = (element: Element) => {
      const style = getComputedStyle(element);

      return {
        style: style.outlineStyle,
        widthPx: Number.parseFloat(style.outlineWidth),
        offsetPx: Number.parseFloat(style.outlineOffset),
        colour: style.outlineColor,
        boxShadow: style.boxShadow,
        borderColour: [
          style.borderTopColor,
          style.borderRightColor,
          style.borderBottomColor,
          style.borderLeftColor,
        ].join(' / '),
      };
    };

    /** Whether a resolved colour paints anything at all. */
    const isOpaqueEnough = (colour: string): boolean => {
      const alpha = /^rgba?\([^)]*[,/]\s*([\d.]+)\s*\)$/u.exec(colour.trim())?.[1];

      return colour.trim() !== 'transparent' && (alpha === undefined || Number(alpha) > 0);
    };

    /** Whether a resolved colour hides everything behind it. */
    const isFullyOpaque = (colour: string): boolean => {
      const alpha = /^rgba?\([^)]*[,/]\s*([\d.]+)\s*\)$/u.exec(colour.trim())?.[1];

      return colour.trim() !== 'transparent' && (alpha === undefined || Number(alpha) >= 1);
    };

    /** The painted layers from `start` outwards, stopping at the first that hides the rest. */
    const surfaceOf = (start: Element | null, source: 'parent' | 'self') => {
      const layers: string[] = [];
      const backgroundImages: string[] = [];
      let element: Element | null = start;
      let terminator = '';

      while (element !== null) {
        const style = getComputedStyle(element);

        if (style.backgroundImage !== 'none') {
          backgroundImages.push(`${describe(element)}: ${style.backgroundImage}`);
        }

        if (isOpaqueEnough(style.backgroundColor)) {
          layers.push(style.backgroundColor);

          if (isFullyOpaque(style.backgroundColor)) {
            terminator = describe(element);
            break;
          }
        }

        element = element.parentElement;
      }

      return {
        source,
        layers,
        element: terminator === '' ? 'the page canvas' : terminator,
        assumedCanvas: terminator === '',
        backgroundImages,
      };
    };

    /** The composite of one element's own background outwards, as the ring sees it. */
    const layersOf = (element: Element): readonly string[] => surfaceOf(element, 'self').layers;

    const outline = styleOf(active);
    const rect = active.getBoundingClientRect();
    const ringOuter = {
      left: rect.left - outline.offsetPx - outline.widthPx,
      top: rect.top - outline.offsetPx - outline.widthPx,
      right: rect.right + outline.offsetPx + outline.widthPx,
      bottom: rect.bottom + outline.offsetPx + outline.widthPx,
    };
    const ringInner = {
      left: rect.left - outline.offsetPx,
      top: rect.top - outline.offsetPx,
      right: rect.right + outline.offsetPx,
      bottom: rect.bottom + outline.offsetPx,
    };

    const ancestors = new Set<Element>();

    for (let walk: Element | null = active; walk !== null; walk = walk.parentElement) {
      ancestors.add(walk);
    }

    const overlapping = [...document.querySelectorAll('*')]
      .filter((element) => !ancestors.has(element))
      .filter((element) => isOpaqueEnough(getComputedStyle(element).backgroundColor))
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const touchesRing =
          box.left < ringOuter.right &&
          box.right > ringOuter.left &&
          box.top < ringOuter.bottom &&
          box.bottom > ringOuter.top;
        const insideTheHole =
          box.left >= ringInner.left &&
          box.right <= ringInner.right &&
          box.top >= ringInner.top &&
          box.bottom <= ringInner.bottom;

        return touchesRing && !insideTheHole;
      })
      .map((element) => ({ element: describe(element), layers: layersOf(element) }));

    return {
      label: describe(active),
      focusableIndex: [...document.querySelectorAll(focusableSelector)].indexOf(active),
      isFocusVisible: active.matches(':focus-visible'),
      outline,
      surface:
        outline.offsetPx >= 0
          ? surfaceOf(active.parentElement, 'parent')
          : surfaceOf(active, 'self'),
      overlapping,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      isInViewport:
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth,
    };
  }, FOCUSABLE_SELECTOR);

/** The outline of every focusable element while nothing is focused. */
const readUnfocusedOutlines = async (page: Page): Promise<readonly OutlineStyle[]> =>
  page.evaluate(
    (focusableSelector: string) =>
      [...document.querySelectorAll(focusableSelector)].map((element) => {
        const style = getComputedStyle(element);

        return {
          style: style.outlineStyle,
          widthPx: Number.parseFloat(style.outlineWidth),
          offsetPx: Number.parseFloat(style.outlineOffset),
          colour: style.outlineColor,
          boxShadow: style.boxShadow,
          borderColour: [
            style.borderTopColor,
            style.borderRightColor,
            style.borderBottomColor,
            style.borderLeftColor,
          ].join(' / '),
        };
      }),
    FOCUSABLE_SELECTOR,
  );

/* ------------------------------------------------------------------- the walk */

/**
 * Presses Tab through the whole tab order of the current state and measures every stop.
 *
 * Starts from a document with nothing focused, so the first Tab lands on the first element in the
 * tab order: the walk blurs whatever holds the focus before it begins. It ends when the focus leaves
 * the document, when it returns to an element it has already measured — which is what a focus trap
 * does, and the Log_View is one (12.8) — or after `maxStops` presses, which is a defect in the page
 * or in this walk rather than a long form.
 *
 * One control needs a rule of its own, and it was found by this walk rather than anticipated:
 * Chromium's `input[type=date]` holds **several** tab stops inside one element, one per date
 * segment, and `document.activeElement` stays the `input` across all of them. A Tab that lands on
 * the element the previous one landed on is therefore an internal segment and not a wrap-around, so
 * the walk presses on without recording it a second time. {@link MAX_INTERNAL_TAB_STOPS} bounds
 * that, so a trap of a single control still ends the walk instead of running to `maxStops`.
 *
 * @param page The page under test, in the state to be measured and already settled: a view still
 *   resolving its first query has a different tab order from the one it ends up with.
 * @throws An `Error` when the tab order did not end within `maxStops` presses.
 */
export const walkTabOrder = async (
  page: Page,
  { maxStops = DEFAULT_MAX_STOPS }: { readonly maxStops?: number } = {},
): Promise<readonly FocusStop[]> => {
  const unfocused = await readUnfocusedOutlines(page);

  await page.evaluate(() => {
    const active = document.activeElement;

    if (active instanceof HTMLElement) {
      active.blur();
    }
  });

  const stops: FocusStop[] = [];
  const seen = new Set<string>();
  let previousIdentity = '';
  let repeats = 0;

  for (let press = 1; press <= maxStops; press += 1) {
    await page.keyboard.press('Tab');

    const report = await readActiveElement(page);

    if (report === null) {
      return stops;
    }

    // The position in the focusable elements where there is one, and the description otherwise: an
    // element the selector does not cover would share the index -1 with every other such element
    // and would stop the walk at the second one.
    const identity =
      report.focusableIndex >= 0
        ? `index:${String(report.focusableIndex)}`
        : `label:${report.label}`;

    if (identity === previousIdentity) {
      repeats += 1;

      if (repeats >= MAX_INTERNAL_TAB_STOPS) {
        // Not a segmented widget after all: the focus is held by one control that Tab cannot leave.
        return stops;
      }

      continue;
    }

    repeats = 0;
    previousIdentity = identity;

    if (seen.has(identity)) {
      // Back where it has already been: a focus trap, or the browser wrapping around to the top of
      // the document. Either way the tab order has been seen once, which is what the walk is for.
      return stops;
    }

    seen.add(identity);
    stops.push(toFocusStop(stops.length + 1, report, unfocused));
  }

  throw new Error(
    `The tab order did not end within ${String(maxStops)} Tab presses. The last stop was ` +
      `${stops.at(-1)?.label ?? 'none'}.`,
  );
};

/**
 * Measures whatever currently holds the focus, without walking the tab order.
 *
 * For the one question a walk cannot answer: whether a control that *refused* a keyboard activation
 * still holds the focus and still shows its ring — the `aria-disabled` pattern of this codebase
 * (2.3). Put the focus there with the keyboard before calling, for the reason in the module header.
 *
 * The returned stop carries `unfocused: null`: the baseline of an element can only be read while it
 * is not focused, and by the time this is called it is. The "an indicator appeared on focus"
 * comparison is therefore not part of a measurement taken this way — {@link walkTabOrder} is what
 * establishes that, for every control of the state including this one.
 *
 * @throws An `Error` when nothing in the document holds the focus.
 */
export const measureFocusedControl = async (page: Page): Promise<FocusStop> => {
  const report = await readActiveElement(page);

  if (report === null) {
    throw new Error(
      'Nothing in the document holds the focus, so there is no focus indicator to measure.',
    );
  }

  return toFocusStop(1, report, []);
};

/** One browser report plus the unfocused baseline of the same element, as a measured stop. */
const toFocusStop = (
  position: number,
  report: ActiveElementReport,
  unfocused: readonly OutlineStyle[],
): FocusStop => {
  const surface = compositeLayers(report.surface.layers);
  const ringColour = compositeOver(parseCssColour(report.outline.colour), surface);

  return {
    position,
    label: report.label,
    focusableIndex: report.focusableIndex,
    isFocusVisible: report.isFocusVisible,
    focused: report.outline,
    unfocused: unfocused[report.focusableIndex] ?? null,
    surface: report.surface,
    ringColour: formatRgba(ringColour),
    contrastRatio: contrastRatio(ringColour, surface),
    overlappingSurfaces: report.overlapping.map((overlap) => {
      const colour = compositeLayers(overlap.layers);

      return {
        element: overlap.element,
        colour: formatRgba(colour),
        contrastRatio: contrastRatio(ringColour, colour),
      };
    }),
    rect: report.rect,
    isInViewport: report.isInViewport,
  };
};

/** A colour as `rgb(11, 79, 156)`, which is how the stylesheet and the report can be compared. */
const formatRgba = ({ red, green, blue }: Rgba): string =>
  `rgb(${[red, green, blue].map((channel) => String(Math.round(channel))).join(', ')})`;

/* -------------------------------------------------------------- the assertion */

/**
 * Asserts that every stop of a walk carries a visible focus indicator at 3 : 1 or better (2.3).
 *
 * Four conditions per stop, and a failure names the stop, the element and the measured values:
 *
 * 1. the element matches `:focus-visible`;
 * 2. it resolves an outline — a style other than `none` and a non-zero width;
 * 3. the same element resolves no such outline while unfocused, so the ring is the focus indicator
 *    and not a permanent border;
 * 4. the ring colour stands at {@link MINIMUM_FOCUS_CONTRAST} or better against the surface behind
 *    it and against every painted element that reaches into the ring band — and that surface is
 *    measurable, which a `background-image` over it would make it not.
 *
 * The complete measurement is attached to the Playwright report either way, because a passing run is
 * the only place the measured ratios can be read.
 *
 * @param stops What {@link walkTabOrder} returned.
 * @param state What was on the screen, as a short English description; it leads the failure message.
 */
export const expectFocusIndicators = async (
  stops: readonly FocusStop[],
  state: string,
): Promise<void> => {
  await test
    .info()
    .attach(`focus indicators — ${state}`, {
      body: describeFocusStops(stops),
      contentType: 'text/plain',
    })
    .catch(() => {
      // Attaching is a convenience and must never replace the assertion below.
    });

  expect(stops.length, `${state}: Tab reached no control at all`).toBeGreaterThan(0);

  const failures = stops.flatMap((stop) =>
    faultsOf(stop).map((fault) => `  ${stop.label}: ${fault}`),
  );

  expect(
    failures.length === 0
      ? ''
      : `${state}\n\n${failures.join('\n')}\n\n${describeFocusStops(stops)}`,
    'the focus indicator of 2.3 failed on at least one control',
  ).toBe('');
};

/** Everything wrong with one stop, as sentences; empty for a stop that holds. */
const faultsOf = (stop: FocusStop): readonly string[] => {
  const faults: string[] = [];

  if (!stop.isFocusVisible) {
    faults.push(
      'the element does not match `:focus-visible` while focused by Tab, so the shell rule that ' +
        'draws the ring never applies to it',
    );
  }

  if (stop.focused.style === 'none' || stop.focused.widthPx === 0) {
    faults.push(
      `no outline while focused (outline-style ${stop.focused.style}, width ` +
        `${String(stop.focused.widthPx)}px, box-shadow ${stop.focused.boxShadow})`,
    );
  }

  if (
    stop.unfocused !== null &&
    stop.unfocused.style === stop.focused.style &&
    stop.unfocused.widthPx === stop.focused.widthPx &&
    stop.unfocused.colour === stop.focused.colour
  ) {
    faults.push(
      'the outline is the same focused and unfocused, so it is a permanent border rather than a ' +
        'focus indicator',
    );
  }

  if (stop.surface.backgroundImages.length > 0) {
    faults.push(
      `the surface behind the ring carries a background image, so its colour cannot be measured ` +
        `from the resolved values: ${stop.surface.backgroundImages.join('; ')}`,
    );
  }

  if (stop.contrastRatio < MINIMUM_FOCUS_CONTRAST) {
    faults.push(
      `the ring ${stop.ringColour} stands at ${stop.contrastRatio.toFixed(2)} : 1 against ` +
        `${compositeDescription(stop)}, below the 3 : 1 of 2.3`,
    );
  }

  for (const overlap of stop.overlappingSurfaces) {
    if (overlap.contrastRatio < MINIMUM_FOCUS_CONTRAST) {
      faults.push(
        `the ring ${stop.ringColour} reaches over ${overlap.element} (${overlap.colour}) at ` +
          `${overlap.contrastRatio.toFixed(2)} : 1, below the 3 : 1 of 2.3`,
      );
    }
  }

  return faults;
};

/** The surface of one stop as one readable phrase. */
const compositeDescription = (stop: FocusStop): string =>
  `${stop.surface.layers.join(' over ') || 'nothing painted'} (${stop.surface.element}${
    stop.surface.assumedCanvas ? ', white canvas assumed' : ''
  })`;

/** The measurement of a whole walk as a readable table, for the Playwright report. */
export const describeFocusStops = (stops: readonly FocusStop[]): string =>
  stops
    .map((stop) =>
      [
        `${String(stop.position)}. ${stop.label}`,
        `   focus-visible: ${String(stop.isFocusVisible)}`,
        `   outline: ${stop.focused.style} ${String(stop.focused.widthPx)}px offset ` +
          `${String(stop.focused.offsetPx)}px ${stop.focused.colour}`,
        `   unfocused: ${
          stop.unfocused === null
            ? 'not read'
            : `${stop.unfocused.style} ${String(stop.unfocused.widthPx)}px`
        }`,
        `   surface: ${compositeDescription(stop)}`,
        `   ratio: ${stop.contrastRatio.toFixed(2)} : 1`,
        ...stop.overlappingSurfaces.map(
          (overlap) =>
            `   over ${overlap.element} (${overlap.colour}): ` +
            `${overlap.contrastRatio.toFixed(2)} : 1`,
        ),
        `   in viewport: ${String(stop.isInViewport)}`,
      ].join('\n'),
    )
    .join('\n');

/* ------------------------------------------------------------- the form fields */

/**
 * Reads every form field of the current state together with the label elements associated with it.
 *
 * See the module header for why this is not what axe's `label` rule decides: axe accepts a name that
 * comes from `aria-label` alone, and 2.3 asks for a label that is *visible* and programmatically
 * associated.
 */
export const readFormFieldLabels = async (page: Page): Promise<readonly FormFieldLabel[]> =>
  page.evaluate(() => {
    const describe = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const type = element.getAttribute('type');
      const name = element.getAttribute('name');

      return (
        `${tag}${type === null ? '' : `[type=${type}]`}` +
        `${name === null ? '' : `[name=${name}]`}${element.id === '' ? '' : `#${element.id}`}`
      );
    };

    /** Whether an element is drawn at all: a box, not `visibility: hidden`, not transparent. */
    const isRendered = (element: Element): boolean => {
      const style = getComputedStyle(element);

      return (
        element.getClientRects().length > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) > 0
      );
    };

    const textOf = (element: Element): string =>
      (element.textContent ?? '').replace(/\s+/gu, ' ').trim();

    return [...document.querySelectorAll('input, select, textarea')].map((field) => {
      const labels: {
        kind: 'label' | 'aria-labelledby' | 'legend';
        text: string;
        isRendered: boolean;
      }[] = [];

      const native =
        field instanceof HTMLInputElement ||
        field instanceof HTMLSelectElement ||
        field instanceof HTMLTextAreaElement
          ? [...(field.labels ?? [])]
          : [];

      for (const label of native) {
        labels.push({ kind: 'label', text: textOf(label), isRendered: isRendered(label) });
      }

      for (const id of (field.getAttribute('aria-labelledby') ?? '').split(/\s+/u)) {
        const target = id === '' ? null : document.getElementById(id);

        if (target !== null) {
          labels.push({
            kind: 'aria-labelledby',
            text: textOf(target),
            isRendered: isRendered(target),
          });
        }
      }

      const legend = field.closest('fieldset')?.querySelector(':scope > legend') ?? null;

      if (legend !== null) {
        labels.push({ kind: 'legend', text: textOf(legend), isRendered: isRendered(legend) });
      }

      return {
        field: describe(field),
        labels,
        namedByAttributeOnly:
          labels.filter((label) => label.isRendered && label.text !== '').length === 0 &&
          (field.getAttribute('aria-label') !== null || field.getAttribute('title') !== null),
      };
    });
  });

/**
 * Asserts that every form field of the current state carries a rendered, associated, non-empty
 * label (2.3).
 *
 * @param fields What {@link readFormFieldLabels} returned.
 * @param state What was on the screen; it leads the failure message.
 */
export const expectVisibleFormFieldLabels = (
  fields: readonly FormFieldLabel[],
  state: string,
): void => {
  const failures = fields
    .filter((field) => !field.labels.some((label) => label.isRendered && label.text !== ''))
    .map(
      (field) =>
        `  ${field.field}: no rendered, associated label with text. Associated labels: ` +
        `${field.labels.length === 0 ? 'none at all' : JSON.stringify(field.labels)}` +
        `${field.namedByAttributeOnly ? '. Its name comes from aria-label or title alone, which axe accepts and 2.3 does not.' : ''}`,
    );

  expect(
    failures.length === 0 ? '' : `${state}\n\n${failures.join('\n')}`,
    'a form field has no visible label programmatically associated with it (2.3)',
  ).toBe('');
};
