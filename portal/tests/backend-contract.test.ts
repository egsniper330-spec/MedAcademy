import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd(), '..');
const backend = (path: string) => readFileSync(resolve(ROOT, 'backend', path), 'utf8');

describe('backend portal contract', () => {
  it('exposes a dedicated portal login route', () => {
    const routes = backend('routes/api.php');
    expect(routes).toContain("$router->post('/portal/auth/login', [AuthController::class, 'portalLogin'])");
  });

  it('rejects students inside the credential pipeline before issuing a session', () => {
    const controller = backend('src/Controllers/AuthController.php');
    const service = backend('src/Services/AuthService.php');
    expect(controller).toContain('portalLogin');
    expect(controller).toContain("['doctor', 'admin', 'super_admin']");
    expect(service).toContain('portal_role_forbidden');
    const loginBody = service.slice(service.indexOf('public function login'), service.indexOf('public function refresh'));
    const roleGate = loginBody.indexOf('portal_role_forbidden');
    const sessionIssue = loginBody.indexOf("'session' => $this->sessions->issue");
    expect(roleGate).toBeGreaterThan(-1);
    expect(sessionIssue).toBeGreaterThan(roleGate);
  });

  it('prevents Admins from modifying administrator accounts', () => {
    const controller = backend('src/Controllers/AdminController.php');
    expect(controller).toContain('assertCanManageAccount');
    expect(controller).toContain("if (in_array((string) $old, ['admin', 'super_admin'], true)");
    expect(controller).toContain("throw new ApiException(403, 'Only a Super Admin can manage administrator accounts");
    // Bulk operations and the dedicated trash route must enforce the same rule.
    expect(controller.match(/Only a Super Admin can trash an administrator account/g)?.length).toBeGreaterThan(0);
    expect(controller.match(/Only a Super Admin can change an administrator account/g)?.length).toBeGreaterThan(0);
    const authController = backend('src/Controllers/AuthController.php');
    expect(authController).toContain("Only a Super Admin can trash an administrator account");
  });

  it('returns every lesson setting the Doctor web editor can update', () => {
    const controller = backend('src/Controllers/CourseController.php');
    const projection = controller.slice(
      controller.indexOf('public function lessons'),
      controller.indexOf('public function create'),
    );
    for (const column of [
      'l.video_type', 'l.youtube_video_id', 'l.video_title', 'l.video_thumbnail_url',
      'l.download_enabled', 'l.comments_enabled', 'l.visible', 'l.notes',
      'l.estimated_minutes', 'l.video_asset_id', 'l.scheduled_at', 'l.is_preview',
    ]) {
      expect(projection).toContain(column);
    }
  });

  it('registers the CSV import and lesson video attachment endpoints', () => {
    const routes = backend('routes/api.php');
    expect(routes).toContain("$router->post('/courses/import'");
    expect(routes).toContain("$router->post('/video/attach-lesson'");
  });
});
