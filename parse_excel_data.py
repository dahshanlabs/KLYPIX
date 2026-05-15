
import csv
import json
from io import StringIO

excel_data = """=== Sheet: Budget 2025 ===
,,,,,,,,,,,Description,Project ID,Project ID Description,Total Investment Amount,Comment,Capital. Start Month,Capital. Start Year,Useful Life(Year),Capex Lead Time Week,Beginning Balance,Quantity,Unit Price,Quantity x Price,Remaining Amount,Total,JAN 2025,FEB 2025,MAR 2025,APR 2025,MAY 2025,JUN 2025,JUL 2025,AUG 2025,SEP 2025,OCT 2025,NOV 2025,DEC 2025
Cost Center,,Internal Order,,Currency,Asset class,,G/L Account,,Strategic/Direct,Capex ID,,,,SAR,,,,,,SAR,UNT,SAR,,,SAR,SAR,SAR,SAR,SAR,SAR,SAR,SAR,SAR,SAR,SAR,SAR,SAR
2360001,Common Operation,#,Not assigned,SAR,2000,Buildings,640010,Depn - Buildings,Direct,CX250003BU,Renovation Project for steam system,PR250003BU,RENOVATION PROJECT FOR STEAM SYSTEM,"1,875,000",,6,2025,33.33,0,0,1,"1,875,000","1,875,000",0,"1,875,000",0,,,,,"1,875,000",,,,,,
2360001,Common Operation,#,Not assigned,SAR,2000,Buildings,640010,Depn - Buildings,Direct,CX250006BU,New Main power Distribution Panel with cables.,PR250006BU,NEW MAIN POWER DISTRIBUTION PANEL WITH CABLES.,"937,500",,2,2025,33.33,0,0,1,"937,500","937,500",0,"937,500",0,"937,500",,,,,,,,,,
2360001,Common Operation,#,Not assigned,SAR,2000,Buildings,640010,Depn - Buildings,Direct,CX250028BU,Irrigation system upgrading,PR250028BU,IRRIGATION SYSTEM UPGRADING,"131,250",,4,2025,33.33,0,0,1,"131,250","131,250",0,"131,250",0,,,"131,250",,,,,,,,
2360001,Common Operation,#,Not assigned,SAR,2000,Buildings,640010,Depn - Buildings,Direct,CX250030BU,New GMP Doors for production areas,PR250030BU,NEW GMP DOORS FOR PRODUCTION AREAS,"112,500",,4,2025,33.33,0,0,15,"7,500","112,500",0,"112,500",0,,,"112,500",,,,,,,,
2360001,Common Operation,#,Not assigned,SAR,2000,Buildings,640010,Depn - Buildings,Direct,CX250037BU,External lighting LED light *,PR250037BU,EXTERNAL LIGHTING LED LIGHT *,"75,000",,2,2025,33.33,0,0,1,"75,000","75,000",0,"75,000",0,"75,000",,,,,,,,,,
2360001,Common Operation,#,Not assigned,SAR,2000,Buildings,640010,Depn - Buildings,Strategic,CX250060BU,KSA complex - design and constructions,PR250060BU,KSA COMPLEX - DESIGN AND CONSTRUCTIONS,"52,500,000",,0,2025,33.33,0,0,1,"52,500,000","52,500,000","52,500,000",0,0,,0,,,,,,,,,
2360001,Common Operation,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250004BU,Compressed air network upgrading ( including  new air compressor & 2 dryers),PR250004BU,,"1,312,500",,8,2025,13.33,0,0,1,"1,312,500","1,312,500",0,"1,312,500",0,,,,,,,,"1,312,500",,,,
2360001,Common Operation,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Strategic,CX250061BU,KSA- machines down payment,PR250061BU,KSA- MACHINES DOWN PAYMENT,"22,500,000",,0,2025,13.33,0,0,1,"22,500,000","22,500,000","22,500,000",0,0,,0,,,,,,,,,
2360001,Common Operation,#,Not assigned,SAR,4000,Furniture & Fixtures,640060,Depn - F & F,Direct,CX250023BU,Archiving area renovation for QA and finance.,PR250023BU,ARCHIVING AREA RENOVATION FOR QA AND FINANCE.,"206,250",,3,2025,10.00,0,0,1,"206,250","206,250",0,"206,250",0,,,"206,250",,,,,,,,,
2360001,Common Operation,#,Not assigned,SAR,4000,Furniture & Fixtures,640060,Depn - F & F,Direct,CX250027BU,BLP & BLC  Changing room lockers,PR250027BU,BLP & BLC  CHANGING ROOM LOCKERS,"168,750",,1,2025,10.00,0,0,1,"168,750","168,750",0,"168,750","168,750",,,,,,,,,,,
2360001,Common Operation,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250005BU,"General tools & Equipments ( punchis ,Tri blender,  format size  , pumps,vacuum cleaner ,trolleys, containers, S.S Table...etc)",PR250005BU,,"1,125,000",,11,2025,4.00,0,0,1,"1,125,000","1,125,000",0,"1,125,000",0,,,,,,,,,,,"1,125,000",
2360001,Common Operation,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250007BU,HVAC Roof Electrical Panels upgrading,PR250007BU,HVAC ROOF ELECTRICAL PANELS UPGRADING,"787,500",,3,2025,4.00,0,0,1,"787,500","787,500",0,"787,500",0,,,"787,500",,,,,,,,,
2321302,GF- Liquid Preparati,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250019BU,Upgrade liquid preparation heat & cooling system of tanks,PR250019BU,,"281,250",,9,2025,13.33,0,0,1,"281,250","281,250",0,"281,250",0,,,,,,,,,"281,250",,,
2324400,Q.C Department.,#,Not assigned,SAR,2000,Buildings,640010,Depn - Buildings,Direct,CX250024BU,Renovation for QC,PR250024BU,RENOVATION FOR QC,"187,500",,8,2025,33.33,0,0,1,"187,500","187,500",0,"187,500",0,,,,,,,,"187,500",,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250010BU,HPLC,PR250010BU,HPLC,"562,500",,8,2025,10.00,0,0,4,"140,625","562,500",0,"562,500",0,,,,,,,,"562,500",,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250020BU,TOC Device,PR250020BU,TOC DEVICE,"262,500",,7,2025,10.00,0,0,1,"262,500","262,500",0,"262,500",0,,,,,,,"262,500",,,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250021BU,Multi Check (Tablet testing system),PR250021BU,MULTI CHECK (TABLET TESTING SYSTEM),"262,500",,7,2025,10.00,0,0,1,"262,500","262,500",0,"262,500",0,,,,,,,"262,500",,,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250022BU,HPLC with CAD detector,PR250022BU,HPLC WITH CAD DETECTOR,"225,000",,8,2025,10.00,0,0,1,"225,000","225,000",0,"225,000",0,,,,,,,,"225,000",,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250031BU,Dissolution Media Prep (Degasser),PR250031BU,DISSOLUTION MEDIA PREP (DEGASSER),"112,500",,8,2025,10.00,0,0,1,"112,500","112,500",0,"112,500",0,,,,,,,,"112,500",,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250032BU,Gas Generator,PR250032BU,GAS GENERATOR,"112,500",,8,2025,10.00,0,0,1,"112,500","112,500",0,"112,500",0,,,,,,,,"112,500",,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250036BU,Viscosity Meter,PR250036BU,VISCOSITY METER,"101,250",,8,2025,10.00,0,0,1,"101,250","101,250",0,"101,250",0,,,,,,,,"101,250",,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250044BU,Balance (3 Digits),PR250044BU,BALANCE (3 DIGITS),"56,250",,8,2025,10.00,0,0,1,"56,250","56,250",0,"56,250",0,,,,,,,,"56,250",,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250045BU,Filtration Unit for Water Test (Manifold),PR250045BU,FILTRATION UNIT FOR WATER TEST (MANIFOLD),"56,250",,8,2025,10.00,0,0,1,"56,250","56,250",0,"56,250",0,,,,,,,,"56,250",,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250053BU,PH Portable,PR250053BU,PH PORTABLE,"22,500",,8,2025,10.00,0,0,1,"22,500","22,500",0,"22,500",0,,,,,,,,"22,500",,,,
2324400,Q.C Department.,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250059BU,Washing Machine,PR250059BU,WASHING MACHINE,"3,750",,8,2025,10.00,0,0,1,"3,750","3,750",0,"3,750",0,,,,,,,,"3,750",,,,
2321101,GF-Solid Powdering,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250013BU,Stainless steel Product filter *,PR250013BU,STAINLESS STEEL PRODUCT FILTER *,"412,500",,4,2025,4.00,0,0,1,"412,500","412,500",0,"412,500",0,,,"412,500",,,,,,,,
2321102,GF-Solid Tableting,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250008BU,"Tableting Machine (B type 36 stations ""EU19"") for GF. 2nd payment",PR250008BU,,"750,000",,2,2025,13.33,0,0,1,"750,000","750,000",0,"750,000",0,"750,000",,,,,,,,,,
2321102,GF-Solid Tableting,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250043BU,Metal detector*,PR250043BU,METAL DETECTOR*,"56,250",,6,2025,13.33,0,0,1,"56,250","56,250",0,"56,250",0,,,,,,"56,250",,,,,,
2321104,GF-Solid Coating,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250002BU,Coating machine 750L for GF - 2nd payment.,PR250002BU,COATING MACHINE 750L FOR GF - 2ND PAYMENT.,"3,000,000",,9,2025,13.33,0,0,1,"3,000,000","3,000,000",0,"3,000,000",0,,,,,,,,,"3,000,000",,,
2321104,GF-Solid Coating,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250017BU,GF Accelacota 150L Controls upgrade.,PR250017BU,GF ACCELACOTA 150L CONTROLS UPGRADE.,"356,250",,7,2025,13.33,0,0,1,"356,250","356,250",0,"356,250",0,,,,,,,"356,250",,,,,
2321107,GF-Solid Cartoning,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250014BU,Narrow aisle forklift for main RPM WH,PR250014BU,NARROW AISLE FORKLIFT FOR MAIN RPM WH,"375,000",,7,2025,13.33,0,0,1,"375,000","375,000",0,"375,000",0,,,,,,,"375,000",,,,,
2321107,GF-Solid Cartoning,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250029BU, VNA forklift maintenance,PR250029BU, VNA FORKLIFT MAINTENANCE,"125,063",,8,2025,13.33,0,0,1,"125,063","125,063",0,"125,063",0,,,,,,,,"125,063",,,,
2321107,GF-Solid Cartoning,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250033BU,Electric pallets forklift  in RPM WH*,PR250033BU,ELECTRIC PALLETS FORKLIFT  IN RPM WH*,"112,500",,7,2025,13.33,0,0,2,"56,250","112,500",0,"112,500",0,,,,,,,,"112,500",,,,,
2321107,GF-Solid Cartoning,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250042BU,Electric pallet Stacker / Jack *,PR250042BU,ELECTRIC PALLET STACKER / JACK *,"60,000",,7,2025,13.33,0,0,1,"60,000","60,000",0,"60,000",0,,,,,,,,"60,000",,,,,
2321107,GF-Solid Cartoning,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250051BU,Scissor lift*,PR250051BU,SCISSOR LIFT*,"30,000",,8,2025,13.33,0,0,1,"30,000","30,000",0,"30,000",0,,,,,,,,"30,000",,,,
2321107,GF-Solid Cartoning,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250035BU,Dock levellers*,PR250035BU,DOCK LEVELLERS*,"108,750",,8,2025,4.00,0,0,2,"54,375","108,750",0,"108,750",0,,,,,,,,"108,750",,,,
2321107,GF-Solid Cartoning,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250038BU,Small covered Umbrella at RPM WH Receiving area *,PR250038BU,SMALL COVERED UMBRELLA AT RPM WH RECEIVING AREA *,"75,000",,7,2025,4.00,0,0,1,"75,000","75,000",0,"75,000",0,,,,,,,,"75,000",,,,,
2321107,GF-Solid Cartoning,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250052BU,Pallet Wrapping machine*,PR250052BU,PALLET WRAPPING MACHINE*,"28,125",,7,2025,4.00,0,0,1,"28,125","28,125",0,"28,125",0,,,,,,,,"28,125",,,,,
2321107,GF-Solid Cartoning,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250054BU,Shutter doors*,PR250054BU,SHUTTER DOORS*,"15,000",,7,2025,4.00,0,0,2,"7,500","15,000",0,"15,000",0,,,,,,,,"15,000",,,,,
2321203,GF- Sem-So. Cartonin,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250009BU,New Ointment filling line 1st payment,PR250009BU,NEW OINTMENT FILLING LINE 1ST PAYMENT,"750,000",,9,2025,13.33,0,0,1,"750,000","750,000",0,"750,000",0,,,,,,,,,"750,000",,,
2321303,GF- Liquid Filling,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250018BU,Liquid filling format,PR250018BU,LIQUID FILLING FORMAT,"337,500",,6,2025,4.00,0,0,1,"337,500","337,500",0,"337,500",0,,,,,,"337,500",,,,,,
2322106,PN - Solid Filling,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Strategic,CX250001BU,PP CAM Powder Filling Line. 2nd payment.,PR250001BU,PP CAM POWDER FILLING LINE. 2ND PAYMENT.,"7,125,000",,9,2025,13.33,0,0,1,"7,125,000","7,125,000",0,"7,125,000",0,,,,,,,,,"7,125,000",,,
2323106,CP - Solid Filling,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250016BU,BLC Powder filling machine HMI/Software upgrade.,PR250016BU,BLC POWDER FILLING MACHINE HMI/SOFTWARE UPGRADE.,"356,250",,5,2025,13.33,0,0,1,"356,250","356,250",0,"356,250",0,,,,\"356,250\",,,,,,,
2324003,Calibration Dep.,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250012BU,Balances,PR250012BU,BALANCES,"450,000",,7,2025,4.00,0,0,15,"30,000","450,000",0,"450,000",0,,,,,,,"450,000",,,,,
2324003,Calibration Dep.,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250055BU,Rotronic Data Logger,PR250055BU,ROTRONIC DATA LOGGER,"8,438",,7,2025,4.00,0,0,15,563,"8,438",0,"8,438",0,,,,,,,"8,438",,,,,
2324003,Calibration Dep.,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250056BU,Calibration Kit for Moister Balance (Mettler),PR250056BU,CALIBRATION KIT FOR MOISTER BALANCE (METTLER),"8,250",,7,2025,4.00,0,0,1,"8,250","8,250",0,"8,250",0,,,,,,,"8,250",,,,,
2324003,Calibration Dep.,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250057BU,Thermocouple GF,PR250057BU,THERMOCOUPLE GF,"7,500",,7,2025,4.00,0,0,1,"7,500","7,500",0,"7,500",0,,,,,,,"7,500",,,,,
2330001,R&D Department,#,Not assigned,SAR,3000,M & E,640020,Depn - M&E,Direct,CX250050BU,Homogenizer,PR250050BU,HOMOGENIZER,"37,500",,8,2025,13.33,0,0,1,"37,500","37,500",0,"37,500",0,,,,,,,,"37,500",,,,
2330001,R&D Department,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250025BU,"Multichecker weight, Thickness, and Hardness",PR250025BU,"MULTICHECKER WEIGHT, THICKNESS, AND HARDNESS","187,500",,7,2025,10.00,0,0,1,"187,500","187,500",0,"187,500",0,,,,,,,"187,500",,,,,
2330001,R&D Department,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250041BU,Disintegration tester,PR250041BU,DISINTEGRATION TESTER,"75,000",,8,2025,10.00,0,0,1,"75,000","75,000",0,"75,000",0,,,,,,,,"75,000",,,,
2330001,R&D Department,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250046BU,Water Purification system-support unit,PR250046BU,WATER PURIFICATION SYSTEM-SUPPORT UNIT,"56,250",,7,2025,10.00,0,0,1,"56,250","56,250",0,"56,250",0,,,,,,,"56,250",,,,,
2330001,R&D Department,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250047BU,Leakage tester,PR250047BU,LEAKAGE TESTER,"56,250",,8,2025,10.00,0,0,1,"56,250","56,250",0,"56,250",0,,,,,,,,"56,250",,,,
2330001,R&D Department,#,Not assigned,SAR,3100,Lab  Equipment,640120,Depn - Lab Equipment,Direct,CX250049BU,Oxygen meter,PR250049BU,OXYGEN METER,"37,500",,7,2025,13.33,0,0,1,"37,500","37,500",0,"37,500",0,,,,,,,"37,500",,,,,
2330001,R&D Department,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250026BU,Blister molds,PR250026BU,BLISTER MOLDS,"168,750",,7,2025,4.00,0,0,3,"56,250","168,750",0,"168,750",0,,,,,,,"168,750",,,,,
2330001,R&D Department,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250034BU,Punches for Bi-layer machine,PR250034BU,PUNCHES FOR BI-LAYER MACHINE,"112,500",,7,2025,4.00,0,0,2,"56,250","112,500",0,"112,500",0,,,,,,,"112,500",,,,,
2330001,R&D Department,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250039BU,"R&D -General tools ( punchis ,Tri blender,  format size  , pumps,vacuum cleaner ,trolleys, containers, S.S Table...etc)",PR250039BU,,"75,000",,7,2025,4.00,0,0,1,"75,000","75,000",0,"75,000",0,,,,,,,"75,000",,,,,
2330001,R&D Department,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250040BU,Punches for R&D machine,PR250040BU,PUNCHES FOR R&D MACHINE,"75,000",,7,2025,4.00,0,0,8,"9,375","75,000",0,"75,000",0,,,,,,,"75,000",,,,,
2330001,R&D Department,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250048BU,Balance 150Kg with printer,PR250048BU,BALANCE 150KG WITH PRINTER,"56,250",,8,2025,4.00,0,0,1,"56,250","56,250",0,"56,250",0,,,,,,,,"56,250",,,,
2330001,R&D Department,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250058BU,Printer for Pilot Balance,PR250058BU,PRINTER FOR PILOT BALANCE,"5,625",,7,2025,4.00,0,0,1,"5,625","5,625",0,"5,625",0,,,,,,,"5,625",,,,,
2360002,Com.-G.F,#,Not assigned,SAR,2000,Buildings,640010,Depn - Buildings,Direct,CX250011BU,GF Ceiling Replacing Project*,PR250011BU,GF CEILING REPLACING PROJECT*,"450,000",,4,2025,33.33,0,0,1,"450,000","450,000",0,"450,000",0,,,,"450,000",,,,,,,,
2324004,HSE,#,Not assigned,SAR,5100,Tools,640130,Depn - Tools,Direct,CX250015BU,safety requirements,PR250015BU,SAFETY REQUIREMENTS,"375,000",,8,2025,4.00,0,0,1,"375,000","375,000",0,"375,000",0,,,,,,,,"375,000",,,,
2370002,Regional HQ SM,#,Not assigned,SAR,5000,Vehicles,640040,Depn - Vehicles,Direct,CX250100BU,Car on HQ,PR250100BU,CAR ON HQ,"375,000",,0,2025,4.00,0,0,1,"375,000","375,000","375,000",0,0,,,,,,,,,,,
,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,,,,,,, "100,668,000" ,"75,375,000" ,"25,293,000" ,"168,750" ,"1,762,500" ,"993,750" ,"1,106,250" ,"356,250" ,"2,268,750" ,"2,739,188" ,"3,616,313" ,"11,156,250" , -   ,"1,125,000" , -   
,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
,,,,,,,,,,,,,,,,,,,,,,,, "$20,100,000" ,"$6,744,800" ,,,,,,,,,,,,
"""

def parse_excel_data(data):
    lines = data.splitlines()
    csv_data_start_index = -1
    for i, line in enumerate(lines):
        if "Description" in line and "Project ID" in line:
            csv_data_start_index = i
            break
    
    if csv_data_start_index == -1:
        return {"error": "Could not find header row in the provided data."}

    csv_content = "\n".join(lines[csv_data_start_index:])
    
    f = StringIO(csv_content)
    reader = csv.reader(f)

    header1 = next(reader) # First header row (main headers)
    header2 = next(reader) # Second header row (sub-headers/categories)

    # Manually construct a definitive header list based on observed data structure
    # This assumes fixed positions for the critical columns we need
    headers = [
        "Cost Center", "Column1", "Internal Order", "Column3", "Currency", 
        "Asset class", "Column6", "G/L Account", "Column8", "Strategic/Direct", 
        "Capex ID", "Description", "Project ID", "Project ID Description", 
        "Total Investment Amount", "Comment", "Capital. Start Month", 
        "Capital. Start Year", "Useful Life(Year)", "Capex Lead Time Week", 
        "Beginning Balance", "Quantity", "Unit Price", "Quantity x Price", 
        "Remaining Amount", "Total", 
        "JAN 2025", "FEB 2025", "MAR 2025", "APR 2025", "MAY 2025", "JUN 2025", 
        "JUL 2025", "AUG 2025", "SEP 2025", "OCT 2025", "NOV 2025", "DEC 2025"
    ]
    
    # For debugging, print the raw headers from CSV to confirm structure
    # print(f"Raw Header 1: {header1}")
    # print(f"Raw Header 2: {header2}")
    # print(f"Constructed Headers: {headers}")

    # Define target column names with precise strings
    asset_class_col_name = "Asset class"
    strategic_direct_col_name = "Strategic/Direct"
    total_investment_col_name = "Total Investment Amount"

    # Find actual indices of the columns
    try:
        asset_class_idx = headers.index(asset_class_col_name)
        strategic_direct_idx = headers.index(strategic_direct_col_name)
        total_investment_idx = headers.index(total_investment_col_name)
    except ValueError as e:
        return {"error": f"Missing expected column: {e}. Constructed headers: {headers}"}

    month_columns = [h for h in headers if "2025" in h and (h.startswith("JAN") or h.startswith("FEB") or h.startswith("MAR") or h.startswith("APR") or h.startswith("MAY") or h.startswith("JUN") or h.startswith("JUL") or h.startswith("AUG") or h.startswith("SEP") or h.startswith("OCT") or h.startswith("NOV") or h.startswith("DEC"))]

    data_rows = []
    for row in reader:
        if any(row) and len(row) >= len(headers): # Ensure row has enough columns
            row_data = {}
            for i, header in enumerate(headers):
                value = row[i].strip().replace('"', '')
                if header in [total_investment_col_name] + month_columns:
                    try:
                        row_data[header] = float(value.replace(",", ""))
                    except ValueError:
                        row_data[header] = 0.0
                else:
                    row_data[header] = value
            data_rows.append(row_data)

    filtered_data = [
        row for row in data_rows
        if row.get(asset_class_col_name) and row.get(total_investment_col_name) is not None and row.get(total_investment_col_name) > 0
    ]
    
    asset_class_investments = {}
    for row in filtered_data:
        asset_class = row.get(asset_class_col_name)
        investment = row.get(total_investment_col_name)
        if asset_class and investment is not None:
            asset_class_investments[asset_class] = asset_class_investments.get(asset_class, 0) + investment

    strategic_direct_investments = {}
    for row in filtered_data:
        strategic_direct = row.get(strategic_direct_col_name)
        investment = row.get(total_investment_col_name)
        if strategic_direct and investment is not None:
            strategic_direct_investments[strategic_direct] = strategic_direct_investments.get(strategic_direct, 0) + investment

    monthly_spending_by_asset_class = {}
    for row in filtered_data:
        asset_class = row.get(asset_class_col_name)
        if asset_class not in monthly_spending_by_asset_class:
            monthly_spending_by_asset_class[asset_class] = {month: 0.0 for month in month_columns}
        for month in month_columns:
            monthly_spending_by_asset_class[asset_class][month] += row.get(month, 0.0)

    monthly_chart_data = []
    for month in month_columns:
        month_data = {"month": month}
        for asset_class, month_spendings in monthly_spending_by_asset_class.items():
            month_data[asset_class] = month_spendings[month]
        monthly_chart_data.append(month_data)

    total_monthly_spending = {month: 0.0 for month in month_columns}
    for month_data in monthly_chart_data:
        for key, value in month_data.items():
            if key != "month":
                total_monthly_spending[month_data["month"]] += value

    overall_total_investment = sum(asset_class_investments.values())

    result = {
        "asset_class_investments": asset_class_investments,
        "strategic_direct_investments": strategic_direct_investments,
        "monthly_spending_by_asset_class": monthly_chart_data,
        "total_monthly_spending": total_monthly_spending,
        "overall_total_investment": overall_total_investment
    }
    print(json.dumps(result))

if __name__ == "__main__":
    parse_excel_data(excel_data)
