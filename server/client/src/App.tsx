import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Leads } from "./pages/Leads";
import { LeadImport } from "./pages/LeadImport";
import { LeadSources } from "./pages/LeadSources";
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
import { Agents } from "./pages/Agents";
import { Tools } from "./pages/Tools";
import { Approvals } from "./pages/Approvals";
import { Rehearsals } from "./pages/Rehearsals";
import { ClientDetail } from "./pages/ClientDetail";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/leads/import" element={<LeadImport />} />
        <Route path="/lead-sources" element={<LeadSources />} />
        <Route path="/proposals" element={<Proposals />} />
        <Route path="/demos" element={<Demos />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/care-plans" element={<CarePlans />} />
        <Route path="/emails" element={<Emails />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/messages" element={<Messages />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/clients/:id" element={<ClientDetail />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/agents/tools" element={<Tools />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/rehearsals" element={<Rehearsals />} />
        <Route path="/rehearsals/:id" element={<Rehearsals />} />
      </Route>
    </Routes>
  );
}
