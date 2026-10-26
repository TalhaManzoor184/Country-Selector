import * as React from "react";
import { Theme } from "@fluentui/react-components";
import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { CountryDropdown, CountryDropdownProps } from "./components/CountryDropdown";
import { normaliseConfig } from "./services/CountryService";

/**
 * CountryDropdownPCF — virtual (React) PCF control bound to a Single Line of Text column.
 *
 * Save model:
 *   user selects -> onChange -> notifyOutputChanged() -> platform calls getOutputs()
 *   -> the form attribute becomes dirty -> the normal form Save persists it.
 * The control never writes to Dataverse itself.
 */
export class CountryDropdownPCF implements ComponentFramework.ReactControl<IInputs, IOutputs> {
    private notifyOutputChanged!: () => void;

    /** Value most recently chosen in the control and not yet echoed back by the platform. */
    private pendingValue: string | null = null;
    private hasPending = false;
    /** The value the control currently represents; what getOutputs() reports. */
    private currentValue: string | null = null;
    private destroyed = false;

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary,
    ): void {
        this.notifyOutputChanged = notifyOutputChanged;
        // Model-driven forms size the control to its column; let it fill the width.
        context.mode.trackContainerResize(false);
    }

    public updateView(context: ComponentFramework.Context<IInputs>): React.ReactElement {
        const p = context.parameters;
        const bound = normaliseText(p.countryValue.raw);

        // Reconcile local selection with the bound value:
        // - Our own change echoed back -> clear pending.
        // - The platform reports a different bound value (form refresh, Cancel/
        //   discard, business rule or script setValue) -> external value wins.
        // - Otherwise (unrelated re-render before the echo) keep showing ours.
        if (this.hasPending) {
            const boundChanged = context.updatedProperties.includes("countryValue");
            if (bound === this.pendingValue || boundChanged) {
                this.hasPending = false;
                this.pendingValue = null;
            }
        }
        const value = this.hasPending ? this.pendingValue : bound;
        this.currentValue = value;

        const security = p.countryValue.security;
        const masked = !!security && security.readable === false;
        const disabled =
            context.mode.isControlDisabled || (!!security && security.editable === false) || masked;

        const config = normaliseConfig({
            tableName: p.countryTableName.raw,
            nameColumn: p.countryNameColumn.raw,
            codeColumn: p.countryCodeColumn.raw,
            activeOnly: p.activeRecordsOnly.raw !== "0",
        });

        const props: CountryDropdownProps = {
            webAPI: context.webAPI,
            config,
            value,
            disabled,
            masked,
            maxLength: p.countryValue.attributes?.MaxLength,
            ariaLabel: p.countryValue.attributes?.DisplayName?.trim() ? p.countryValue.attributes.DisplayName : "Country",
            theme: getFluentTheme(context),
            onChange: this.handleChange,
        };

        return React.createElement(CountryDropdown, props);
    }

    public getOutputs(): IOutputs {
        // undefined clears the column (saved as null); a string sets it.
        return { countryValue: this.currentValue ?? undefined };
    }

    public destroy(): void {
        // The platform unmounts the React tree for virtual controls; effects in
        // useCountries flag in-flight requests as obsolete on unmount.
        this.destroyed = true;
    }

    private handleChange = (next: string | null): void => {
        if (this.destroyed) {
            return;
        }
        this.pendingValue = normaliseText(next);
        this.currentValue = this.pendingValue;
        this.hasPending = true;
        this.notifyOutputChanged();
    };
}

function normaliseText(v: string | null | undefined): string | null {
    if (v === null || v === undefined) {
        return null;
    }
    const t = v.trim();
    return t.length > 0 ? t : null;
}

/** Uses the host app's Fluent v9 theme when the platform provides one. */
function getFluentTheme(context: ComponentFramework.Context<IInputs>): Theme | undefined {
    const host = (context as unknown as { fluentDesignLanguage?: { tokenTheme?: unknown } })
        .fluentDesignLanguage;
    return host?.tokenTheme ? (host.tokenTheme as Theme) : undefined;
}
