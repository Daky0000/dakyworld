import { lazy } from "react";
import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Guard, Landing } from "./components/Guard";
const Dashboard = lazy(() => import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })));
const Leads = lazy(() => import("./pages/Leads").then((module) => ({ default: module.Leads })));
const LeadImport = lazy(() => import("./pages/LeadImport").then((module) => ({ default: module.LeadImport })));
const LeadSources = lazy(() => import("./pages/LeadSources").then((module) => ({ default: module.LeadSources })));
const Hunts = lazy(() => import("./pages/Hunts").then((module) => ({ default: module.Hunts })));
const Proposals = lazy(() => import("./pages/Proposals").then((module) => ({ default: module.Proposals })));
const Demos = lazy(() => import("./pages/Demos").then((module) => ({ default: module.Demos })));
const Concepts = lazy(() => import("./pages/Concepts").then((module) => ({ default: module.Concepts })));
const Projects = lazy(() => import("./pages/Projects").then((module) => ({ default: module.Projects })));
const ProjectDetail = lazy(() => import("./pages/ProjectDetail").then((module) => ({ default: module.ProjectDetail })));
const Invoices = lazy(() => import("./pages/Invoices").then((module) => ({ default: module.Invoices })));
const CarePlans = lazy(() => import("./pages/CarePlans").then((module) => ({ default: module.CarePlans })));
const Emails = lazy(() => import("./pages/Emails").then((module) => ({ default: module.Emails })));
const Inbox = lazy(() => import("./pages/Inbox").then((module) => ({ default: module.Inbox })));
const Messages = lazy(() => import("./pages/Messages").then((module) => ({ default: module.Messages })));
const Clients = lazy(() => import("./pages/Clients").then((module) => ({ default: module.Clients })));
const Settings = lazy(() => import("./pages/Settings").then((module) => ({ default: module.Settings })));
const Team = lazy(() => import("./pages/Team").then((module) => ({ default: module.Team })));
const Agents = lazy(() => import("./pages/Agents").then((module) => ({ default: module.Agents })));
const Tools = lazy(() => import("./pages/Tools").then((module) => ({ default: module.Tools })));
const Costs = lazy(() => import("./pages/Costs").then((module) => ({ default: module.Costs })));
const Approvals = lazy(() => import("./pages/Approvals").then((module) => ({ default: module.Approvals })));
const Rehearsals = lazy(() => import("./pages/Rehearsals").then((module) => ({ default: module.Rehearsals })));
const ClientDetail = lazy(() => import("./pages/ClientDetail").then((module) => ({ default: module.ClientDetail })));
const Website = lazy(() => import("./pages/Website").then((module) => ({ default: module.Website })));
const WebsiteEditor = lazy(() => import("./pages/WebsiteEditor").then((module) => ({ default: module.WebsiteEditor })));
const WebsiteFrameworkEditor = lazy(() => import("./pages/WebsiteFrameworkEditor").then((module) => ({ default: module.WebsiteFrameworkEditor })));
import { WebsiteLayout } from "./components/WebsiteLayout";
import { WebsiteGuard } from "./components/WebsiteGuard";
import { ErrorBoundary } from "./components/ErrorBoundary";
const WebsiteSource = lazy(() => import("./components/WebsiteSourceEditor").then((module) => ({ default: module.WebsiteSource })));
const WebsiteOverview = lazy(() => import("./pages/WebsiteOverview").then((module) => ({ default: module.WebsiteOverview })));
// The plan's remaining screens. Each says what it will hold and is gated on
// website.manage — see components/PlannedScreen.tsx and docs/website-builder.md.
const WebsiteAssets = lazy(() => import("./pages/WebsiteAssets").then((module) => ({ default: module.WebsiteAssets })));
const WebsiteCompatibility = lazy(() => import("./pages/WebsiteCompatibility").then((module) => ({ default: module.WebsiteCompatibility })));
const WebsiteSurvey = lazy(() => import("./pages/WebsiteSurvey").then((module) => ({ default: module.WebsiteSurvey })));
const WebsiteOnboarding = lazy(() => import("./pages/WebsiteOnboarding").then((module) => ({ default: module.WebsiteOnboarding })));
const ProductPricing = lazy(() => import("./pages/ProductPricing").then((module) => ({ default: module.ProductPricing })));
const WebsiteAI = lazy(() => import("./pages/WebsiteAI").then((module) => ({ default: module.WebsiteAI })));
const WebsiteUpdates = lazy(() => import("./pages/WebsiteUpdates").then((module) => ({ default: module.WebsiteUpdates })));
const WebsiteTeam = lazy(() => import("./pages/WebsiteTeam").then((module) => ({ default: module.WebsiteTeam })));
const WebsiteAudit = lazy(() => import("./pages/WebsiteAudit").then((module) => ({ default: module.WebsiteAudit })));
const WebsiteSettings = lazy(() => import("./pages/WebsiteSettings").then((module) => ({ default: module.WebsiteSettings })));
const WebsiteBilling = lazy(() => import("./pages/WebsiteBilling").then((module) => ({ default: module.WebsiteBilling })));
const WebsiteBalance = lazy(() => import("./pages/WebsiteBalance").then((module) => ({ default: module.WebsiteBalance })));

/**
 * Screens are loaded when somebody goes to them, not all at once.
 *
 * The whole operations suite was one download. A client on the Website product
 * is offered four screens and was being sent the other thirty-three — every
 * lead, invoice, agent and rehearsal screen — before they could see anything.
 * On the networks this is actually used on, that is the difference between the
 * editor opening and the editor eventually opening.
 *
 * The shell stays eager: layouts and guards render on every route, so splitting
 * them would buy nothing and cost a round trip.
 */
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
        <Route path="/concepts" element={<Guard needs="demos.view"><Concepts /></Guard>} />
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
        <Route path="/website" element={<WebsiteGuard><WebsiteLayout /></WebsiteGuard>}>
          <Route index element={<WebsiteOverview />} />
          <Route path="sites" element={<Website />} />
          <Route path="assets" element={<WebsiteAssets />} />
          <Route path="compatibility" element={<WebsiteCompatibility />} />
          <Route path="survey" element={<WebsiteSurvey />} />
          <Route path="onboarding" element={<Guard needs="website.manage"><WebsiteOnboarding /></Guard>} />
          <Route path="ai" element={<Guard needs="website.manage"><WebsiteAI /></Guard>} />
          <Route path="updates" element={<Guard needs="website.manage"><WebsiteUpdates /></Guard>} />
          <Route path="team" element={<WebsiteTeam />} />
          <Route path="audit" element={<WebsiteAudit />} />
          <Route path="balance" element={<WebsiteBalance />} />
          <Route path="settings" element={<WebsiteGuard needs="manage"><WebsiteSettings /></WebsiteGuard>} />
          <Route path="source" element={<WebsiteGuard needs="source"><WebsiteSource /></WebsiteGuard>} />
          <Route path="billing" element={<Guard needs="website.manage"><WebsiteBilling /></Guard>} />
        </Route>
        <Route path="/products/pricing" element={<Guard needs="website.view"><ProductPricing /></Guard>} />
        <Route path="/website/pages/:pageId" element={<WebsiteGuard><ErrorBoundary label="website editor"><WebsiteEditor /></ErrorBoundary></WebsiteGuard>} />
        <Route path="/website/pages/:pageId/source" element={<WebsiteGuard needs="source"><ErrorBoundary label="source editor"><WebsiteFrameworkEditor /></ErrorBoundary></WebsiteGuard>} />
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
