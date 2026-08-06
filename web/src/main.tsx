import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import Shell from './shell'
import Login from './pages/Login'
import Home from './pages/Home'
import Dashboard from './pages/Dashboard'
import NewProject from './pages/NewProject'
import ProjectOverview from './pages/ProjectOverview'
import RunView from './pages/RunView'
import Knowledge from './pages/Knowledge'
import ClaimDetail from './pages/ClaimDetail'
import Sources from './pages/Sources'
import Review from './pages/Review'
import Conflicts from './pages/Conflicts'
import ImportPage from './pages/ImportPage'
import GlobalSearch from './pages/GlobalSearch'
import Keys from './pages/Keys'
import Settings from './pages/Settings'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Shell />}>
          <Route path="/" element={<Home />} />
          <Route path="/activity" element={<Dashboard />} />
          <Route path="/new" element={<NewProject />} />
          <Route path="/search" element={<GlobalSearch />} />
          <Route path="/keys" element={<Keys />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/projects/:id" element={<ProjectOverview />} />
          <Route path="/projects/:id/knowledge" element={<Knowledge />} />
          <Route path="/projects/:id/sources" element={<Sources />} />
          <Route path="/projects/:id/review" element={<Review />} />
          <Route path="/projects/:id/conflicts" element={<Conflicts />} />
          <Route path="/projects/:id/import" element={<ImportPage />} />
          <Route path="/projects/:id/runs/:runId" element={<RunView />} />
          <Route path="/claims/:claimId" element={<ClaimDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
