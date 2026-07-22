import type { LucideIcon } from "lucide-react";
import {
  getDestination,
  type Destination,
  type DestinationId,
} from "@/lib/navigation/destinations";

/** The resolved shape the rail and sheet render. */
export interface NavItem {
  id: DestinationId;
  label: string;
  href: string;
  icon: LucideIcon;
  presentation: NavItemPresentation;
}

export type NavItemPresentation = "default" | "accent";

interface AppNavigationDestinationDefinition {
  id: DestinationId;
  presentation?: NavItemPresentation;
}

interface AppNavigationDefinition {
  destinations: readonly [
    AppNavigationDestinationDefinition,
    ...AppNavigationDestinationDefinition[],
  ];
  account: AppNavigationDestinationDefinition;
}

export interface NavDestination extends Destination {
  presentation: NavItemPresentation;
}

/** The sole owner of fixed app-navigation membership, order, and decoration. */
export const APP_NAVIGATION = {
  destinations: [
    { id: "lectern" },
    { id: "libraries" },
    { id: "podcasts" },
    { id: "chats" },
    { id: "notes" },
    { id: "atlas" },
    { id: "oracle", presentation: "accent" },
  ],
  account: { id: "settings" },
} as const satisfies AppNavigationDefinition;

function resolveNavDestination(
  definition: AppNavigationDestinationDefinition,
): NavDestination {
  return {
    ...getDestination(definition.id),
    presentation: definition.presentation ?? "default",
  };
}

export const NAV_MODEL: readonly NavDestination[] =
  APP_NAVIGATION.destinations.map(resolveNavDestination);
export const NAV_HOME = resolveNavDestination(APP_NAVIGATION.destinations[0]);
export const NAV_ACCOUNT = resolveNavDestination(APP_NAVIGATION.account);
