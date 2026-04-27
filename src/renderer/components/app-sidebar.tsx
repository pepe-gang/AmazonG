import * as React from "react";
import { LayoutDashboard, Users, Tag, Settings, ShoppingBag, Zap, Landmark } from "lucide-react";

import { NavMain } from "@/components/nav-main";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/**
 * AmazonG's top-level nav targets. Logs are opened as a dialog from
 * the jobs table, not a nav destination. Settings split out of
 * Accounts so the Accounts page is just per-account management and
 * global toggles live behind their own tab.
 */
const navItems = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Purchases", url: "/purchases", icon: ShoppingBag },
  { title: "Deals",     url: "/deals",     icon: Tag },
  { title: "Bank",      url: "/bank",      icon: Landmark },
  { title: "Accounts",  url: "/accounts",  icon: Users },
  { title: "Settings",  url: "/settings",  icon: Settings },
];

export function AppSidebar({ version, ...props }: React.ComponentProps<typeof Sidebar> & { version?: string }) {
  return (
    <Sidebar
      collapsible="icon"
      variant="inset"
      className="glass-chrome top-12 h-[calc(100svh-3rem)] border-r border-white/5 bg-gradient-to-b from-white/[0.03] to-white/[0.005]"
      {...props}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="#/dashboard">
                <div className="flex aspect-square size-9 shrink-0 items-center justify-center rounded-lg bg-accent-gradient text-white shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.3)]">
                  <Zap className="size-5" />
                </div>
                <div className="flex flex-col gap-0.5 leading-none group-data-[collapsible=icon]:hidden">
                  <span className="font-semibold">AmazonG</span>
                  {version && <span className="text-xs text-muted-foreground">v{version}</span>}
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navItems} />
      </SidebarContent>
    </Sidebar>
  );
}
