// The fallback field for an unknown `ui:field`.
//
// A Backstage template can reference a CUSTOM field extension (a `ui:field` we do
// not ship — e.g. `CakePickerWithDefault` from the plugin-composed example). RJSF
// would otherwise ERROR on an unregistered field and blank the whole form. So we
// register THIS field as the default fallback: a labelled input with a hint
// naming the field, into which the user types the value the real extension would
// produce. The raw text is parsed as JSON when it looks like JSON, else kept as a
// string (see `parseCustomFieldValue`) — so the produced form value has the right
// TYPE. It never crashes the form.

import { Field, Input, makeStyles, Text, tokens } from "@fluentui/react-components";
import type { FieldProps } from "@rjsf/utils";
import type * as React from "react";
import { parseCustomFieldValue } from "../lib/customValue.ts";
import { ORIGINAL_FIELD_OPTION } from "../lib/remapCustomFields.ts";

const useStyles = makeStyles({
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/**
 * The fallback for any `ui:field` we do not ship. `remapCustomFields` routes the
 * unknown extension here and stashes its ORIGINAL name in
 * `ui:options.tdkOriginalField` — we read that to name it in the hint. The value
 * shows as raw text, and the user's input parses back to a JSON value (or string)
 * on change.
 */
export function CustomFieldFallback(props: FieldProps): React.ReactElement {
  const styles = useStyles();
  const { schema, uiSchema, formData, onChange, name } = props;
  const options = (uiSchema?.["ui:options"] ?? {}) as Record<string, unknown>;
  const fieldName = (options[ORIGINAL_FIELD_OPTION] as string | undefined) ?? name ?? "custom field";
  const label = (schema.title as string | undefined) ?? name ?? fieldName;

  // Show the current value as text: strings verbatim, everything else as JSON.
  const text =
    formData === undefined || formData === null
      ? ""
      : typeof formData === "string"
        ? formData
        : JSON.stringify(formData);

  return (
    <Field label={label}>
      <Input value={text} onChange={(_e, data) => onChange(parseCustomFieldValue(data.value))} />
      <Text className={styles.hint}>custom field '{fieldName}' — enter the value it would produce</Text>
    </Field>
  );
}
