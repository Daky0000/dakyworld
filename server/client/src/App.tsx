import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Leads } from "./pages/Leads";
import { LeadImport } from "./pages/LeadImport";
import { LeadSources } from "./pages/LeadSources";
import { Proposals } from "./pages/Proposals";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Invoices } from "./pages/Invoices";
import { Clients } from "./pages/Clients";
import { Settings } from "./pages/Settings";
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
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/clients/:id" element={<ClientDetail />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
