import { type LucideIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
};

/**
 * Main sidebar nav — mirrors Bestie's shape but wired to AmazonG's
 * three top-level routes. Active state comes from react-router's
 * `useLocation`; clicks navigate via `NavLink`, which the shadcn
 * `SidebarMenuButton asChild` prop slots into.
 */
export function NavMain({ items }: { items: NavItem[] }) {
  const location = useLocation();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Workspace</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.title}>
            <SidebarMenuButton
              asChild
              tooltip={item.title}
              isActive={location.pathname === item.url}
            >
              <NavLink to={item.url}>
                <item.icon />
                <span className="group-data-[collapsible=icon]:hidden">{item.title}</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
