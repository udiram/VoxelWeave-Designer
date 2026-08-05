import { ProjectProvider, useProject } from "./state/ProjectContext";
import { Shell } from "./features/shell/Shell";
import { DesignWorkspace } from "./features/design/DesignWorkspace";
import { DicomWorkspace } from "./features/dicom/DicomWorkspace";
import { CalibrateWorkspace } from "./features/calibrate/CalibrateWorkspace";
import { PrepareWorkspace } from "./features/prepare/PrepareWorkspace";
import { SendWorkspace } from "./features/send/SendWorkspace";
import { VerifyWorkspace } from "./features/verify/VerifyWorkspace";

function WorkspaceRouter() {
  const { state } = useProject();
  switch (state.ui.workspace) {
    case "dicom": return <DicomWorkspace />;
    case "calibrate": return <CalibrateWorkspace />;
    case "prepare": return <PrepareWorkspace />;
    case "send": return <SendWorkspace />;
    case "verify": return <VerifyWorkspace />;
    case "design":
    default: return <DesignWorkspace />;
  }
}

export function App() {
  return <ProjectProvider><Shell><WorkspaceRouter /></Shell></ProjectProvider>;
}
