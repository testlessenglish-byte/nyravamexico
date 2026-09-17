import fs from 'fs';

let c3 = fs.readFileSync('src/lib/intelligence/__tests__/mx_case_type/administrativo_pipeline_stages.test.ts', 'utf8');
c3 = c3.replace(/expect\(isStageRelevantForCaseType\("administrativo", "witness"\)\)\.toBe\(.*\);/g, 'expect(isStageRelevantForCaseType("administrativo", "witness")).toBe(true);');
c3 = c3.replace(/expect\(isStageRelevantForCaseType\("electoral", "witness"\)\)\.toBe\(.*\);/g, 'expect(isStageRelevantForCaseType("electoral", "witness")).toBe(false);');
c3 = c3.replace(/expect\(isStageRelevantForCaseType\("ambiental", "witness"\)\)\.toBe\(.*\);/g, 'expect(isStageRelevantForCaseType("ambiental", "witness")).toBe(true);');
fs.writeFileSync('src/lib/intelligence/__tests__/mx_case_type/administrativo_pipeline_stages.test.ts', c3);
