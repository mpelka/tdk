// RJSF template overrides for the form panel — passed as the `templates` prop on the
// themed `<Form>`.
//
// TITLE HIERARCHY. RJSF renders EVERY field title through the ONE `TitleFieldTemplate`
// — the array field's own title ("Line items") AND each item's title ("Line items-1").
// The fluentui-rc default paints both as an `h5` at size 600, so an array item's
// heading lands at the SAME visual level as the field it sits inside — confusing (you
// can't tell the container from its rows). We override the template to split the two:
//
//   - the FIELD-level title keeps the theme's prominent heading (h5 / Divider),
//   - an array ITEM title becomes a small, muted caption ("Item N"), clearly a rung
//     below its field's heading.
//
// HOW WE TELL THEM APART. The only signal on `TitleFieldProps` is the `id`. RJSF's id
// scheme puts the item INDEX as the segment right before the `__title` suffix:
//   root_items__title           → the array field's own title  (segment: "items")
//   root_items_0__title         → item 0's title               (segment: "0")
//   root_items_0_options__title → item 0's nested array field   (segment: "options")
// So an id whose last pre-`__title` segment is all DIGITS is an array-item title; any
// other (a property name) is a field title. Matching on the id keeps this independent
// of the (localized, index-suffixed) title TEXT.

import { Caption1, Divider, makeStyles, shorthands, Text, tokens } from "@fluentui/react-components";
import type { TemplatesType, TitleFieldProps } from "@rjsf/utils";
import type * as React from "react";

/** An id like `…_<digits>__title` — the item-index segment marks an ARRAY-ITEM title. */
const ARRAY_ITEM_TITLE_ID = /_\d+__title$/;

/** Whether a `TitleFieldTemplate` id names an array ITEM (vs a field) title. */
export function isArrayItemTitleId(id: string): boolean {
  return ARRAY_ITEM_TITLE_ID.test(id);
}

const useStyles = makeStyles({
  // The FIELD-level title — the theme's prominent heading (matches fluentui-rc's
  // default: an h5 followed by a divider).
  fieldTitle: { ...shorthands.margin("8px", "0", "4px", "0") },
  // The ITEM-level caption — deliberately smaller and muted, a clear rung below the
  // field heading so an item reads as a row WITHIN the field, not a peer of it.
  itemTitle: {
    display: "block",
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
    ...shorthands.margin("6px", "0", "2px", "0"),
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
});

/**
 * The custom `TitleFieldTemplate`. Field titles render as the theme's heading; array
 * ITEM titles render as a small "Item N" caption (a real visual rung below the field).
 */
function TitleFieldTemplate({ id, title }: TitleFieldProps): React.ReactElement | null {
  const styles = useStyles();
  if (!title) return null;

  if (isArrayItemTitleId(id)) {
    // "Line items-1" → "Item 1": the RJSF item title is `<fieldTitle>-<n>`; show just
    // the ordinal as a compact caption. If the `-N` suffix is somehow absent, fall
    // back to the raw title so nothing is lost.
    const match = /-(\d+)$/.exec(title);
    const caption = match ? `Item ${match[1]}` : title;
    return (
      <Caption1
        as="span"
        id={id}
        className={styles.itemTitle}
        data-array-item-title="true"
        data-testid={`item-title-${id}`}
      >
        {caption}
      </Caption1>
    );
  }

  return (
    <div id={id} className={styles.fieldTitle} data-testid={`field-title-${id}`}>
      <Text as="h5" size={600}>
        {title}
      </Text>
      <Divider />
    </div>
  );
}

/** The template overrides handed to the form's `templates` prop. */
export const formTemplates: Partial<TemplatesType> = {
  TitleFieldTemplate,
};
