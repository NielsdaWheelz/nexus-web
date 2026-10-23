"use client";

// The containing document owns image delivery and recovery. Shared content has
// no dependency on Next's router or image runtime.
import { createContext, useContext, type ComponentType, type ImgHTMLAttributes, type ReactNode } from "react";
export type HostImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height"> & {
  src: string; alt: string; width?: number | `${number}`; height?: number | `${number}`;
  fill?: boolean; priority?: boolean; unoptimized?: boolean;
};
export interface HostPolicy {
  Image: ComponentType<HostImageProps>;
  recover(): void;
  project(href: string, replace?: boolean): void;
}
function OriginalImage({ fill, priority, unoptimized: _unoptimized, style, ...props }: HostImageProps) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} loading={priority ? "eager" : props.loading ?? "lazy"} style={fill ? { position: "absolute", width: "100%", height: "100%", inset: 0, ...style } : style} />;
}
export const installedHostPolicy: HostPolicy = {
  Image: OriginalImage,
  recover: () => window.location.reload(),
  project: (href, replace = false) => window.history[replace ? "replaceState" : "pushState"](window.history.state, "", href),
};
const Context = createContext<HostPolicy>(installedHostPolicy);
export function HostPolicyProvider({ value, children }: { value: HostPolicy; children: ReactNode }) {
  return <Context value={value}>{children}</Context>;
}
export const useHostPolicy = () => useContext(Context);
const NavigationContext = createContext<string | null>(null);
export function NavigationIdentity({ value, children }: { value: string; children: ReactNode }) {
  return <NavigationContext value={value}>{children}</NavigationContext>;
}
export const useNavigationIdentity = () => useContext(NavigationContext);
