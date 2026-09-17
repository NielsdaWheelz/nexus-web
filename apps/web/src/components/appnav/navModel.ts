import type { LucideIcon } from "lucide-react";
import {
  getDestination,
  type DestinationId,
} from "@/lib/navigation/destinations";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteTable";

/** The resolved shape the rail and sheet render. */
export interface NavItem {
  id: DestinationId;
  label: string;
  href: string;
  icon: LucideIcon;
  presentation: NavItemPresentation;
}

type NavItemPresentation = "default" | "accent";

interface AppNavigationDestinationDefinition {
  id: DestinationId;
  presentation?: NavItemPresentation;
}

interface AppNavigationDefinition {
  destinations: readonly [
    AppNavigationDestinationDefinition,
    ...AppNavigationDestinationDefinition[],
  ];
  account: {
    stats: AppNavigationDestinationDefinition;
    settings: AppNavigationDestinationDefinition;
  };
}

interface AccountNavigation {
  stats: NavItem;
  settings: NavItem;
}

/** The sole owner of the rail list's membership and order, and of the Account cluster. */
const APP_NAVIGATION = {
  destinations: [
    { id: "lectern" },
    { id: "libraries" },
    { id: "browse" },
    { id: "podcasts" },
    { id: "chats" },
    { id: "notes" },
    { id: "atlas" },
    { id: "oracle", presentation: "accent" },
  ],
  account: {
    stats: { id: "stats" },
    settings: { id: "settings" },
  },
} as const satisfies AppNavigationDefinition;

function resolveNavDestination(
  definition: AppNavigationDestinationDefinition,
): NavItem {
  const destination = getDestination(definition.id);
  return {
    ...destination,
    icon: destination.icon ?? getPaneRouteIcon(destination.href),
    presentation: definition.presentation ?? "default",
  };
}

export const NAV_MODEL: readonly NavItem[] =
  APP_NAVIGATION.destinations.map(resolveNavDestination);
export const NAV_HOME = resolveNavDestination(APP_NAVIGATION.destinations[0]);
export const NAV_IMPORTS: NavItem = resolveNavDestination({ id: "imports" });
export const NAV_ACCOUNT: AccountNavigation = {
  stats: resolveNavDestination(APP_NAVIGATION.account.stats),
  settings: resolveNavDestination(APP_NAVIGATION.account.settings),
};

export function isAccountDestinationId(
  destinationId: DestinationId | null,
): destinationId is AccountNavigation[keyof AccountNavigation]["id"] {
  return (
    destinationId === NAV_ACCOUNT.stats.id ||
    destinationId === NAV_ACCOUNT.settings.id
  );
}
