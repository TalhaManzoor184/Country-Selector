import * as React from "react";
import {
    Button,
    Combobox,
    ComboboxProps,
    Field,
    FluentProvider,
    Option,
    Spinner,
    Theme,
    makeStyles,
    tokens,
    webLightTheme,
} from "@fluentui/react-components";
import { Country, CountryConfig } from "../services/CountryService";
import { useCountries } from "../hooks/useCountries";

export interface CountryDropdownProps {
    webAPI: ComponentFramework.WebApi;
    config: CountryConfig;
    /** Current value of the bound text column (null = empty). */
    value: string | null;
    disabled: boolean;
    /** True when field-level security hides the value from this user. */
    masked: boolean;
    /** MaxLength of the bound column, used to warn before an over-long value. */
    maxLength?: number;
    /** Accessible name, taken from the field's label on the form. */
    ariaLabel: string;
    theme?: Theme;
    onChange: (value: string | null) => void;
}

/** Hard cap on rendered options; keeps the listbox fast for very large tables. */
const MAX_VISIBLE_OPTIONS = 300;
const NO_MATCH_VALUE = "__country_pcf_no_match__";
const MORE_VALUE = "__country_pcf_more__";

const useStyles = makeStyles({
    root: {
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
    },
    combobox: {
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
    },
    input: {
        minWidth: 0,
        width: "100%",
        textOverflow: "ellipsis",
    },
    listbox: {
        maxHeight: "320px",
        overflowY: "auto",
    },
    optionRow: {
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalS,
        width: "100%",
        minWidth: 0,
    },
    optionName: {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    optionCode: {
        flexShrink: 0,
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    hintRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        flexWrap: "wrap",
    },
});

/** Lowercase + strip diacritics so "cote" matches "Côte d'Ivoire". */
function fold(text: string): string {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLocaleLowerCase()
        .trim();
}

interface IndexedCountry extends Country {
    foldedName: string;
    foldedCode: string;
}

function filterCountries(list: IndexedCountry[], query: string): IndexedCountry[] {
    const q = fold(query);
    if (!q) {
        return list;
    }
    const starts: IndexedCountry[] = [];
    const contains: IndexedCountry[] = [];
    for (const c of list) {
        if (c.foldedName.startsWith(q) || c.foldedCode === q) {
            starts.push(c);
        } else if (c.foldedName.includes(q) || (c.foldedCode !== "" && c.foldedCode.startsWith(q))) {
            contains.push(c);
        }
    }
    return starts.concat(contains);
}

export const CountryDropdown: React.FC<CountryDropdownProps> = (props) => {
    const { webAPI, config, value, disabled, masked, maxLength, ariaLabel, theme, onChange } = props;
    const styles = useStyles();
    const { status, countries, error, retry } = useCountries(webAPI, config);

    const selectedName = value ?? "";
    // Text shown in the input. While the user is searching it holds the query;
    // otherwise it mirrors the selected value.
    const [inputText, setInputText] = React.useState(selectedName);
    const [isSearching, setIsSearching] = React.useState(false);

    // External value changes (form load/refresh, Cancel, other scripts)
    // must be reflected unless the user is mid-search.
    React.useEffect(() => {
        if (!isSearching) {
            setInputText(selectedName);
        }
    }, [selectedName, isSearching]);

    const indexed = React.useMemo<IndexedCountry[]>(
        () =>
            countries.map((c) => ({
                ...c,
                foldedName: fold(c.name),
                foldedCode: c.code ? fold(c.code) : "",
            })),
        [countries],
    );

    const matches = React.useMemo(
        () => (isSearching ? filterCountries(indexed, inputText) : indexed),
        [indexed, inputText, isSearching],
    );
    const visible = matches.length > MAX_VISIBLE_OPTIONS ? matches.slice(0, MAX_VISIBLE_OPTIONS) : matches;

    const valueInList = React.useMemo(() => {
        if (!selectedName) {
            return true;
        }
        const f = fold(selectedName);
        return indexed.some((c) => c.foldedName === f);
    }, [indexed, selectedName]);

    const commit = React.useCallback(
        (next: string | null) => {
            setIsSearching(false);
            setInputText(next ?? "");
            if ((next ?? null) !== (value ?? null)) {
                onChange(next);
            }
        },
        [onChange, value],
    );

    const onOptionSelect: ComboboxProps["onOptionSelect"] = (_e, data) => {
        if (data.optionValue === NO_MATCH_VALUE || data.optionValue === MORE_VALUE) {
            return;
        }
        // optionValue is undefined when the clear (x) button is used.
        commit(data.optionValue ?? null);
    };

    const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setIsSearching(true);
        setInputText(e.target.value);
    };

    const onOpenChange: ComboboxProps["onOpenChange"] = (_e, data) => {
        if (!data.open) {
            // Closing without a selection (Escape, click away, Tab) discards the
            // search text and restores the saved value. Free text is never saved.
            setIsSearching(false);
            setInputText(selectedName);
        }
    };

    if (masked) {
        return (
            <FluentProvider theme={theme ?? webLightTheme} className={styles.root}>
                <Combobox className={styles.combobox} input={{ className: styles.input }} aria-label={ariaLabel} value="********" disabled />
            </FluentProvider>
        );
    }

    const hasMaxLength = !!maxLength && maxLength > 0;
    let validationState: "error" | "warning" | "none" = "none";
    let validationMessage: React.ReactElement | string | undefined;
    let hint: React.ReactElement | undefined;

    if (status === "error" && error) {
        validationState = "error";
        validationMessage = (
            <span className={styles.hintRow}>
                <span title={error.detail}>{error.message}</span>
                {error.kind !== "config" && (
                    <Button size="small" appearance="transparent" onClick={retry}>
                        Retry
                    </Button>
                )}
            </span>
        );
    } else if (status === "loading") {
        hint = (
            <span className={styles.hintRow} aria-live="polite">
                <Spinner size="extra-tiny" /> Loading countries…
            </span>
        );
    } else if (status === "ready" && countries.length === 0) {
        validationState = "warning";
        validationMessage = "No countries are available. The country table is empty or you can't see any rows.";
    } else if (status === "ready" && !valueInList) {
        validationState = "warning";
        validationMessage = "The saved value is not in the country list.";
    }

    const placeholder =
        status === "loading" ? "Loading countries…" : status === "error" ? "Countries unavailable" : "Search country";

    return (
        <FluentProvider theme={theme ?? webLightTheme} className={styles.root}>
            <Field validationState={validationState} validationMessage={validationMessage} hint={hint}>
                <Combobox
                    className={styles.combobox}
                    input={{ className: styles.input, autoComplete: "off" }}
                    listbox={{ className: styles.listbox }}
                    aria-label={ariaLabel}
                    aria-busy={status === "loading"}
                    placeholder={placeholder}
                    value={inputText}
                    selectedOptions={selectedName ? [selectedName] : []}
                    onOptionSelect={onOptionSelect}
                    onChange={onInputChange}
                    onOpenChange={onOpenChange}
                    // Selecting is only possible from the list, never free text.
                    freeform={false}
                    clearable={!disabled && !!selectedName}
                    disabled={disabled || status !== "ready" || countries.length === 0}
                    positioning={{ autoSize: "width", fallbackPositions: ["above"] }}
                    inlinePopup={false}
                >
                    {visible.map((c) => {
                        const overflow = hasMaxLength && c.name.length > (maxLength ?? 0);
                        return (
                            <Option
                                key={c.id}
                                value={c.name}
                                text={c.name}
                                disabled={overflow}
                                title={overflow ? `Longer than the column's ${maxLength} character limit` : c.name}
                            >
                                <span className={styles.optionRow}>
                                    <span className={styles.optionName}>{c.name}</span>
                                    {c.code && <span className={styles.optionCode}>{c.code}</span>}
                                </span>
                            </Option>
                        );
                    })}
                    {status === "ready" && countries.length > 0 && matches.length === 0 && (
                        <Option key={NO_MATCH_VALUE} value={NO_MATCH_VALUE} text="" disabled>
                            No countries match “{inputText.trim()}”
                        </Option>
                    )}
                    {matches.length > MAX_VISIBLE_OPTIONS && (
                        <Option key={MORE_VALUE} value={MORE_VALUE} text="" disabled>
                            {`Showing ${MAX_VISIBLE_OPTIONS} of ${matches.length} — keep typing to narrow`}
                        </Option>
                    )}
                </Combobox>
            </Field>
        </FluentProvider>
    );
};
