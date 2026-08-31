import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Guard, Landing } from "./components/Guard";
import { Dashboard } from "./pages/Dashboard";
import { Leads } from "./pages/Leads";
import { LeadImport } from "./pages/LeadImport";
import { LeadSources } from "./pages/LeadSources";
import { Hunts } from "./pages/Hunts";
import { Proposals } from "./pages/Proposals";
import { Demos } from "./pages/Demos";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Invoices } from "./pages/Invoices";
import { CarePlans } from "./pages/CarePlans";
import { Emails } from "./pages/Emails";
import { Inbox } from "./pages/Inbox";
import { Messages } from "./pages/Messages";
import { Clients } from "./pages/Clients";
import { Settings } from "./pages/Settings";
import { Team } from "./pages/Team";
import { Agents } from "./pages/Agents";
import { Tools } from "./pages/Tools";
import { Costs } from "./pages/Costs";
import { Approvals } from "./pages/Approvals";
import { Rehearsals } from "./pages/Rehearsals";
import { ClientDetail } from "./pages/ClientDetail";
import { Website } from "./pages/Website";
import { WebsiteEditor } from "./pages/WebsiteEditor";
import { WebsiteLayout } from "./components/WebsiteLayout";
import { WebsiteOverview } from "./pages/WebsiteOverview";
// The plan's remaining screens. Each says what it will hold and is gated on
// website.manage — see components/PlannedScreen.tsx and docs/website-builder.md.
import { WebsiteAssets } from "./pages/WebsiteAssets";
import { WebsiteAI } from "./pages/WebsiteAI";
import { WebsiteUpdates } from "./pages/WebsiteUpdates";
import { WebsiteTeam } from "./pages/WebsiteTeam";
import { WebsiteAudit } from "./pages/WebsiteAudit";
import { WebsiteSettings } from "./pages/WebsiteSettings";
import { WebsiteBilling } from "./pages/WebsiteBilling";

/**
 * Every screen carries the permission its own API routes ask for.
 *
 * The nav already hides what somebody cannot reach, so in normal use none of
 * these fire. They are here for the ways a person arrives at a URL without
 * going through the nav — a bookmark, a pasted link, the back button — where
 * the alternative is a page that renders and then fails one query at a time.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          path="/"
          element={
            <Landing>
              <Dashboard />
            </Landing>
          }
        />
        <Route path="/leads" element={<Guard needs="leads.view"><Leads /></Guard>} />
        <Route path="/leads/import" element={<Guard needs="leads.import"><LeadImport /></Guard>} />
        <Route path="/lead-sources" element={<Guard needs="leads.sources"><LeadSources /></Guard>} />
        <Route path="/hunts" element={<Guard needs="leads.sources"><Hunts /></Guard>} />
        <Route path="/proposals" element={<Guard needs="proposals.view"><Proposals /></Guard>} />
        <Route path="/demos" element={<Guard needs="demos.view"><Demos /></Guard>} />
        <Route path="/projects" element={<Guard needs="projects.view"><Projects /></Guard>} />
        <Route path="/projects/:id" element={<Guard needs="projects.view"><ProjectDetail /></Guard>} />
        <Route path="/invoices" element={<Guard needs="invoices.view"><Invoices /></Guard>} />
        <Route path="/care-plans" element={<Guard needs="retainers.view"><CarePlans /></Guard>} />
        <Route path="/emails" element={<Guard needs="emails.view"><Emails /></Guard>} />
        <Route path="/inbox" element={<Guard needs="inbox.view"><Inbox /></Guard>} />
        <Route path="/messages" element={<Guard needs="messages.view"><Messages /></Guard>} />
        <Route path="/clients" element={<Guard needs="clients.view"><Clients /></Guard>} />
        <Route path="/clients/:id" element={<Guard needs="clients.view"><ClientDetail /></Guard>} />
        {/* The builder's management screens share a sub-navigation strip; the
            editor deliberately does not, because it takes the whole window. */}
        <Route path="/website" element={<Guard needs="website.view"><WebsiteLayout /></Guard>}>
          <Route index element={<WebsiteOverview />} />
          <Route path="sites" element={<Website />} />
          <Route path="assets" element={<Guard needs="website.manage"><WebsiteAssets /></Guard>} />
          <Route path="ai" element={<Guard needs="website.manage"><WebsiteAI /></Guard>} />
          <Route path="updates" element={<Guard needs="website.manage"><WebsiteUpdates /></Guard>} />
          <Route path="team" element={<Guard needs="website.manage"><WebsiteTeam /></Guard>} />
          <Route path="audit" element={<Guard needs="website.manage"><WebsiteAudit /></Guard>} />
          <Route path="settings" element={<Guard needs="website.manage"><WebsiteSettings /></Guard>} />
          <Route path="billing" element={<Guard needs="website.manage"><WebsiteBilling /></Guard>} />
        </Route>
        <Route path="/website/pages/:pageId" element={<Guard needs="website.view"><WebsiteEditor /></Guard>} />
        <Route path="/team" element={<Guard needs="team.view"><Team /></Guard>} />
        <Route path="/settings" element={<Guard needs="settings.view"><Settings /></Guard>} />
        <Route path="/agents" element={<Guard needs="agents.view"><Agents /></Guard>} />
        <Route path="/agents/tools" element={<Guard needs="agents.tools"><Tools /></Guard>} />
        <Route path="/costs" element={<Guard needs="agents.costs"><Costs /></Guard>} />
        <Route path="/approvals" element={<Guard needs="agents.approvals.view"><Approvals /></Guard>} />
        <Route path="/rehearsals" element={<Guard needs="agents.rehearsals.view"><Rehearsals /></Guard>} />
        <Route path="/rehearsals/:id" element={<Guard needs="agents.rehearsals.view"><Rehearsals /></Guard>} />
      </Route>
    </Routes>
  );
}
