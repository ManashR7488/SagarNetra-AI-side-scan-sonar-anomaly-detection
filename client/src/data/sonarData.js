import img_000023 from '../images_sonar/000023_jpg.rf.cd067115ac89eb3aede0164bae2c2f17.jpg';
import img_000083 from '../images_sonar/000083_jpg.rf.f88785e4af1528075d5605e2e911a5e1.jpg';
import img_000099 from '../images_sonar/000099_jpg.rf.753ba430230ecf6acc61d6225c657677.jpg';
import img_000106 from '../images_sonar/000106_jpg.rf.6625a56c5c50ab1e0e2c329128aca659.jpg';
import img_000109 from '../images_sonar/000109_jpg.rf.a22cc4e5913e2a401835bd836e4bc999.jpg';
import img_000208 from '../images_sonar/000208_jpg.rf.8bac6e212783f14f9ade57f4d41e4f52.jpg';
import img_000325 from '../images_sonar/000325_jpg.rf.99683a36353b6c739dcc7ab6f0da6dd3.jpg';
import img_000326 from '../images_sonar/000326_jpg.rf.6e16e5487dc225a67c0235ecc9a61454.jpg';
import img_000396 from '../images_sonar/000396_jpg.rf.cae2b6fbe01c1f79120fde3b163e4a0f.jpg';
import img_000594 from '../images_sonar/000594_jpg.rf.b11a59bbb9a697fe90a7134e4b68c58b.jpg';
import img_000595 from '../images_sonar/000595_jpg.rf.3be8e3f48d3bcf986353db2abec63e66.jpg';
import img_000597 from '../images_sonar/000597_jpg.rf.e2c3d4dab8d247c1023b0c09f11ecd59.jpg';
import img_000644 from '../images_sonar/000644_jpg.rf.abebf9111d695fb76f6056ec1de6f260.jpg';
import img_eb_allen_06 from '../images_sonar/EB_Allen_06.png';
import img_eb_allen_07 from '../images_sonar/EB_Allen_07.png';
import img_eb_allen_21 from '../images_sonar/EB_Allen_21.png';
import img_eb_allen_22 from '../images_sonar/EB_Allen_22.png';
import img_eb_allen_23 from '../images_sonar/EB_Allen_23.png';
import img_eb_allen_24 from '../images_sonar/EB_Allen_24.png';

/**
 * Bundled sample sonar images for demos.
 *  - ai4shipwrecks: native side-scan survey strips (AI4Shipwrecks dataset, Lake Huron)
 *  - sonar_detect:  mixed sonar images from the Roboflow "sonar_detect" dataset
 *
 * These images carry no navigation data. `demoGeoref` is a DEMO survey position in the Bay of Bengal
 * so that geotagging, the map and the cleanup route can be demonstrated; the UI labels it as such.
 */
export const SAMPLE_SCANS = [
  {
    id: 'SONAR-EB-06',
    name: 'E.B. Allen wreck strip #06',
    dataset: 'ai4shipwrecks',
    filename: 'EB_Allen_06.png',
    image: img_eb_allen_06,
    demoGeoref: { latitude: 13.0842, longitude: 80.3824, headingDeg: 142.5 },
  },
  {
    id: 'SONAR-EB-07',
    name: 'E.B. Allen wreck strip #07',
    dataset: 'ai4shipwrecks',
    filename: 'EB_Allen_07.png',
    image: img_eb_allen_07,
    demoGeoref: { latitude: 13.0855, longitude: 80.3846, headingDeg: 145.0 },
  },
  {
    id: 'SONAR-EB-21',
    name: 'E.B. Allen wreck strip #21',
    dataset: 'ai4shipwrecks',
    filename: 'EB_Allen_21.png',
    image: img_eb_allen_21,
    demoGeoref: { latitude: 13.0831, longitude: 80.3810, headingDeg: 138.2 },
  },
  {
    id: 'SONAR-EB-22',
    name: 'E.B. Allen wreck strip #22',
    dataset: 'ai4shipwrecks',
    filename: 'EB_Allen_22.png',
    image: img_eb_allen_22,
    demoGeoref: { latitude: 13.0862, longitude: 80.3819, headingDeg: 140.7 },
  },
  {
    id: 'SONAR-EB-23',
    name: 'E.B. Allen wreck strip #23',
    dataset: 'ai4shipwrecks',
    filename: 'EB_Allen_23.png',
    image: img_eb_allen_23,
    demoGeoref: { latitude: 13.0878, longitude: 80.3837, headingDeg: 144.1 },
  },
  {
    id: 'SONAR-EB-24',
    name: 'E.B. Allen wreck strip #24',
    dataset: 'ai4shipwrecks',
    filename: 'EB_Allen_24.png',
    image: img_eb_allen_24,
    demoGeoref: { latitude: 13.0890, longitude: 80.3861, headingDeg: 146.8 },
  },
  {
    id: 'SONAR-000023',
    name: 'sonar_detect #000023',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000023.jpg',
    image: img_000023,
    demoGeoref: { latitude: 13.0285, longitude: 80.4180, headingDeg: 88.4 },
  },
  {
    id: 'SONAR-000083',
    name: 'sonar_detect #000083',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000083.jpg',
    image: img_000083,
    demoGeoref: { latitude: 13.1340, longitude: 80.3625, headingDeg: 215.3 },
  },
  {
    id: 'SONAR-000099',
    name: 'sonar_detect #000099',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000099.jpg',
    image: img_000099,
    demoGeoref: { latitude: 13.0515, longitude: 80.4410, headingDeg: 310.8 },
  },
  {
    id: 'SONAR-000106',
    name: 'sonar_detect #000106',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000106.jpg',
    image: img_000106,
    demoGeoref: { latitude: 13.1520, longitude: 80.4080, headingDeg: 72.5 },
  },
  {
    id: 'SONAR-000109',
    name: 'sonar_detect #000109',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000109.jpg',
    image: img_000109,
    demoGeoref: { latitude: 13.0145, longitude: 80.3735, headingDeg: 165.0 },
  },
  {
    id: 'SONAR-000208',
    name: 'sonar_detect #000208',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000208.jpg',
    image: img_000208,
    demoGeoref: { latitude: 13.0470, longitude: 80.3995, headingDeg: 85.2 },
  },
  {
    id: 'SONAR-000325',
    name: 'sonar_detect #000325',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000325.jpg',
    image: img_000325,
    demoGeoref: { latitude: 13.1180, longitude: 80.4320, headingDeg: 198.6 },
  },
  {
    id: 'SONAR-000326',
    name: 'sonar_detect #000326',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000326.jpg',
    image: img_000326,
    demoGeoref: { latitude: 13.0760, longitude: 80.4490, headingDeg: 92.1 },
  },
  {
    id: 'SONAR-000396',
    name: 'sonar_detect #000396',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000396.jpg',
    image: img_000396,
    demoGeoref: { latitude: 13.1410, longitude: 80.3790, headingDeg: 280.4 },
  },
  {
    id: 'SONAR-000594',
    name: 'sonar_detect #000594',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000594.jpg',
    image: img_000594,
    demoGeoref: { latitude: 13.1025, longitude: 80.3550, headingDeg: 175.2 },
  },
  {
    id: 'SONAR-000595',
    name: 'sonar_detect #000595',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000595.jpg',
    image: img_000595,
    demoGeoref: { latitude: 13.0330, longitude: 80.4360, headingDeg: 325.0 },
  },
  {
    id: 'SONAR-000597',
    name: 'sonar_detect #000597',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000597.jpg',
    image: img_000597,
    demoGeoref: { latitude: 13.1590, longitude: 80.4215, headingDeg: 110.5 },
  },
  {
    id: 'SONAR-000644',
    name: 'sonar_detect #000644',
    dataset: 'sonar_detect',
    filename: 'sonar_detect_000644.jpg',
    image: img_000644,
    demoGeoref: { latitude: 13.0635, longitude: 80.3920, headingDeg: 90.0 },
  },
];

export const SAMPLE_PRESETS = {
  all: { label: 'All samples (19)', filter: () => true },
  ai4shipwrecks: { label: 'E.B. Allen wreck strips (6)', filter: (s) => s.dataset === 'ai4shipwrecks' },
  sonar_detect: { label: 'sonar_detect images (13)', filter: (s) => s.dataset === 'sonar_detect' },
};
