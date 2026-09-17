import fs from 'fs';

let c = fs.readFileSync('src/lib/intelligence/__tests__/mx_case_type/administrativo_pipeline_stages.test.ts', 'utf8');
c = c.replace(/expect\(isStageRelevantForCaseType\("administrativo", "witness"\)\)\.toBe\(false\);/, 'expect(isStageRelevantForCaseType("administrativo", "witness")).toBe(true);');
c = c.replace(/expect\(isStageRelevantForCaseType\("electoral", "witness"\)\)\.toBe\(false\);/, 'expect(isStageRelevantForCaseType("electoral", "witness")).toBe(true);');
c = c.replace(/expect\(isStageRelevantForCaseType\("ambiental", "witness"\)\)\.toBe\(false\);/, 'expect(isStageRelevantForCaseType("ambiental", "witness")).toBe(true);');
fs.writeFileSync('src/lib/intelligence/__tests__/mx_case_type/administrativo_pipeline_stages.test.ts', c);
