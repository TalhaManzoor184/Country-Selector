import * as React from "react";
import {
    Country,
    CountryConfig,
    CountryLoadError,
    classifyError,
    configKey,
    invalidateCountries,
    loadCountries,
} from "../services/CountryService";

export type LoadStatus = "loading" | "ready" | "error";

export interface CountriesState {
    status: LoadStatus;
    countries: Country[];
    error?: CountryLoadError;
    retry: () => void;
}

/**
 * Loads the country list once per configuration.
 *
 * The effect depends only on the configuration key (plain string) and a retry
 * counter, so the frequent updateView() re-renders of a model-driven form never
 * trigger new requests. A late response from an obsolete configuration, or one
 * that arrives after the control is destroyed (unmounted), is ignored.
 */
export function useCountries(webAPI: ComponentFramework.WebApi, config: CountryConfig): CountriesState {
    const key = configKey(config);
    const [attempt, setAttempt] = React.useState(0);
    const [state, setState] = React.useState<Omit<CountriesState, "retry">>({
        status: "loading",
        countries: [],
    });

    // webAPI / config objects are recreated on every updateView; keep the
    // latest in refs so they are not effect dependencies.
    const webApiRef = React.useRef(webAPI);
    webApiRef.current = webAPI;
    const configRef = React.useRef(config);
    configRef.current = config;

    React.useEffect(() => {
        let active = true;
        setState((prev) => ({ status: "loading", countries: prev.countries }));

        let request: Promise<Country[]>;
        try {
            request = loadCountries(webApiRef.current, configRef.current);
        } catch (err: unknown) {
            setState({ status: "error", countries: [], error: classifyError(err) });
            return undefined;
        }

        request
            .then((countries) => {
                if (active) {
                    setState({ status: "ready", countries });
                }
                return undefined;
            })
            .catch((err: unknown) => {
                if (active) {
                    setState({ status: "error", countries: [], error: classifyError(err) });
                }
            });

        return () => {
            active = false;
        };
    }, [key, attempt]);

    const retry = React.useCallback(() => {
        invalidateCountries(configRef.current);
        setAttempt((n) => n + 1);
    }, []);

    return { ...state, retry };
}
