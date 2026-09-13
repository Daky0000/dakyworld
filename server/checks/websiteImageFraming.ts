import assert from 'node:assert/strict';
import { validFramingDeclaration, clampFocal, cropResolution } from '../src/shared/websiteImageFraming.js';
import { safeStyle } from '../src/services/website/index.js';
import { safeResponsiveStyle } from '../src/shared/websiteResponsive.js';
assert.equal(clampFocal(-3),0);assert.equal(clampFocal(200),100);assert.equal(clampFocal(NaN),50);
assert.deepEqual(cropResolution(1600,900,1),{width:900,height:900});
assert.deepEqual(cropResolution(100,100,16/9),{width:100,height:56.25});
for(const value of ['-1 / 2','0 / 1','16 / 0','NaN','1 / 2 / 3']) {assert.equal(validFramingDeclaration('aspect-ratio',value),false);assert.equal(safeStyle(`aspect-ratio: ${value}`),'');assert.equal(safeResponsiveStyle(`aspect-ratio: ${value}`),'');}
for(const value of ['-1% 50%','101% 20%','50% 50% 50%']) assert.equal(safeStyle(`object-position: ${value}`),'');
assert.equal(safeStyle('object-position: 0% 100%; aspect-ratio: 16 / 9'),'object-position: 0% 100%; aspect-ratio: 16 / 9');
assert.equal(safeStyle('object-position: -20% 50%','object-position: -20% 50%'),'object-position: -20% 50%','Preserve developer source styles');
console.log('Image framing: boundaries, invalid ratios, desktop/responsive sanitization, crop resolution and existing source preservation passed.');
