
import pandas as pd
import io
import matplotlib.pyplot as plt
import base64
import csv

excel_data = """Asset (Item) Description,Segment,Asset Type,Strategic/ Direct,Operational/ Non-Operational,Cost Center,Cost Center Name,Function,Site / Company,2024 Carried Forward,2025 Related Budget,Total 2025 FY Original Budget
 KSA Complex- Civi Works , Injectable , Buildings , Strategic , Operational ,JPI, JPI , OH , HP (New Copmlex) ,," 6,000,000 ",," 6,000,000 "
 KSA Complex- Civi Works , Branded , Buildings , Strategic , Operational ,, JPI , OH , HP (New Copmlex) ,," 4,700,000 ",," 4,700,000 "
 PP CAM Powder Filling Line. 2nd payment.  , Branded , Machinery & Equipment , Strategic , Operational ,2322106, PN - SOLID FILLING , OH , JPI ,," 1,900,000 ",," 1,900,000 "
 KSA Complex- Machines , Branded , Machinery & Equipment , Strategic , Operational ,, JPI , OH , HP (New Copmlex) ,," 5,000,000 ",," 5,000,000 "
 Blister line , Branded , Machinery & Equipment , Direct ,,,, OH , JPI ,," 2,000,000 ",," 2,000,000 "
 Coating machine 750L for GF - 2nd payment. , Branded , Machinery & Equipment , Direct , Operational ,2321104, GF-SOLID COATING , OH , JPI ,," 800,000 ",," 800,000 "
 Renovation Project for steam system , Branded , Buildings , Direct , Operational ,2360001, COMMON OPERATION , OH , JPI ,," 500,000 ",," 500,000 "
 Compressed air network upgrading ( including  new air compressor & 2 dryers) , Branded , Machinery & Equipment , Direct , Operational ,2360001, COMMON OPERATION , OH , JPI ,," 350,000 ",," 350,000 "
" General tools & Equipments ( punchis ,Tri blender,  format size  , pumps,vacuum cleaner ,trolleys, containers, S.S Table...etc) ", Branded , Tools , Direct , Operational ,2360001, COMMON OPERATION , OH , JPI ,," 400,000 ",," 400,000 "
 New Main power Distribution Panel with cables. , Branded , Buildings , Direct , Operational ,2360001, COMMON OPERATION , OH , JPI ,," 250,000 ",," 250,000 "
 HVAC Roof Electrical Panels upgrading , Branded , Tools , Direct , Operational ,2360001, COMMON OPERATION , OH , JPI ,," 210,000 ",," 210,000 "
" Tableting Machine (B type 36 stations ""EU19"") for GF. 2nd payment ", Branded , Machinery & Equipment , Direct , Operational ,2321102, GF-SOLID TABLETING , OH , JPI ,," 200,000 ",," 200,000 "
 New Ointment filling line 1st payment  , Branded , Machinery & Equipment , Direct , Operational ,2321203, GF- SEM-SO. CARTONIN , OH , JPI ,," 200,000 ",," 200,000 "
 HPLC , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 150,000 ",," 150,000 "
 GF Ceiling Replacing Project* , Branded , Buildings , Direct , Operational ,2360002, COM.-G.F , OH , JPI ,," 120,000 ",," 120,000 "
 Balances , Branded , Tools , Direct , Operational ,2324003, CALIBRATION DEP. , OH , JPI ,," 120,000 ",," 120,000 "
 Stainless steel Product filter * , Branded , Tools , Direct , Operational ,2321101, GF-SOLID POWDERING , OH , JPI ,," 110,000 ",," 110,000 "
 Narrow aisle forklift for main RPM WH  , Branded , Machinery & Equipment , Direct , Operational ,2321107, WAREHOUSE DEPARTMENT , OH , JPI ,," 100,000 ",," 100,000 "
 safety requirements , Branded , Tools , Direct , Non-Operational ,2324004, HSE , OH , JPI ,," 100,000 ",," 75,000 "
 BLC Powder filling machine HMI/Software upgrade.  , Branded , Machinery & Equipment , Direct , Operational ,2323106, CP - SOLID FILLING , OH , JPI ,," 95,000 ",," 95,000 "
 GF Accelacota 150L Controls upgrade. , Branded , Machinery & Equipment , Direct , Operational ,2321104, GF-SOLID COATING , OH , JPI ,," 95,000 ",," 95,000 "
 Liquid filling format  , Branded , Tools , Direct , Operational ,2321303, GF- LIQUID FILLING , OH , JPI ,," 90,000 ",," 90,000 "
 Upgrade liquid preparation heat & cooling system of tanks  , Branded , Machinery & Equipment , Direct , Operational ,2321302, GF- LIQUID PREPARATI , OH , JPI ,," 75,000 ",," 75,000 "
 TOC Device , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 70,000 ",," 70,000 "
 Multi Check (Tablet testing system) , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 70,000 ",," 70,000 "
 HPLC with CAD detector , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 60,000 ",," 60,000 "
 Archiving area renovation for QA and finance. , Branded , Fixtures & Furniture , Direct , Operational ,2360001, COMMON OPERATION , OH , JPI ,," 55,000 ",," 55,000 "
 Renovation for QC , Branded , Buildings , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 50,000 ",," 50,000 "
" Multichecker weight, Thickness, and Hardness ", Branded , Lab equipment , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 50,000 ",," 50,000 "
 Blister molds , Branded , Tools , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 45,000 ",," 45,000 "
 BLP & BLC  Changing room lockers , Branded , Fixtures & Furniture , Direct , Direct ,2360001, COMMON OPERATION , OH , JPI ,," 45,000 ",," 45,000 "
 Irrigation system upgrading  , Branded , Buildings , Direct , Operational ,2360001, COMMON OPERATION , OH , JPI ,," 35,000 ",," 35,000 "
  VNA forklift maintenance , Branded , Machinery & Equipment , Direct , Operational ,2321107, WAREHOUSE DEPARTMENT , OH , JPI ,," 33,350 ",," 33,350 "
 New GMP Doors for production areas , Branded , Buildings , Direct , Operational ,2360001, COMMON OPERATION , OH , JPI ,," 30,000 ",," 30,000 "
 Dissolution Media Prep (Degasser) , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 30,000 ",," 30,000 "
 Gas Generator , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 30,000 ",," 30,000 "
 Electric pallets forklift  in RPM WH* , Branded , Machinery & Equipment , Direct , Operational ,2321107, WAREHOUSE DEPARTMENT , OH , JPI ,," 30,000 ",," 30,000 "
 Punches for Bi-layer machine , Branded , Tools , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 30,000 ",," 30,000 "
 Dock levellers* , Branded , Tools , Direct , Operational ,2321107, WAREHOUSE DEPARTMENT , OH , JPI ,," 29,000 ",," 29,000 "
 Viscosity Meter , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 27,000 ",," 27,000 "
 External lighting LED light * , Branded , Buildings , Direct , Operational ,2360001, COMMON OPERATION , OH , JPI ,," 20,000 ",," 20,000 "
 Small covered Umbrella at RPM WH Receiving area * , Branded , Tools , Direct , Operational ,2321107, WAREHOUSE DEPARTMENT , OH , JPI ,," 20,000 ",," 20,000 "
" R&D -General tools ( punchis ,Tri blender,  format size  , pumps,vacuum cleaner ,trolleys, containers, S.S Table...etc) ", Branded , Tools , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 20,000 ",," 20,000 "
 Punches for R&D machine , Branded , Tools , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 20,000 ",," 20,000 "
 Disintegration tester , Branded , Lab equipment , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 20,000 ",," 20,000 "
 Electric pallet Stacker / Jack * , Branded , Machinery & Equipment , Direct , Operational ,2321107, WAREHOUSE DEPARTMENT , OH , JPI ,," 16,000 ",," 16,000 "
 Metal detector* , Branded , Machinery & Equipment , Direct , Operational ,2321102, GF-SOLID TABLETING , OH , JPI ,," 15,000 ",," 15,000 "
 Balance (3 Digits) , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 15,000 ",," 15,000 "
 Filtration Unit for Water Test (Manifold) , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 15,000 ",," 15,000 "
 Water Purification system-support unit , Branded , Lab equipment , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 15,000 ",," 15,000 "
 Leakage tester , Branded , Lab equipment , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 15,000 ",," 15,000 "
 Balance 150Kg with printer , Branded , Tools , R&D , Direct ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 15,000 ",," 15,000 "
 Oxygen meter  , Branded , Lab equipment , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 10,000 ",," 10,000 "
 Homogenizer , Branded , Machinery & Equipment , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 10,000 ",," 10,000 "
 Scissor lift* , Branded , Machinery & Equipment , Direct , Operational ,2321107, WAREHOUSE DEPARTMENT , OH , JPI ,," 8,000 ",," 8,000 "
 Pallet Wrapping machine* , Branded , Tools , Direct , Operational ,2321107, WAREHOUSE DEPARTMENT , OH , JPI ,," 7,500 ",," 7,500 "
 PH Portable , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 6,000 ",," 6,000 "
 Shutter doors* , Branded , Tools , Direct , Operational ,2321107, WAREHOUSE DEPARTMENT , OH , JPI ,," 4,000 ",," 4,000 "
 Rotronic Data Logger  , Branded , Tools , Direct , Operational ,2324003, CALIBRATION DEP. , OH , JPI ,," 2,250 ",," 2,250 "
 Calibration Kit for Moister Balance (Mettler) , Branded , Tools , Direct , Operational ,2324003, CALIBRATION DEP. , OH , JPI ,," 2,200 ",," 2,200 "
 Thermocouple GF , Branded , Tools , Direct , Operational ,2324003, CALIBRATION DEP. , OH , JPI ,," 2,200 ",," 2,200 "
 Printer for Pilot Balance , Branded , Tools , R&D , Operational ,2330001, R & D DEPARTMENT. , R&D , JPI ,," 1,500 ",," 1,500 "
 Washing Machine , Branded , Lab equipment , Direct , Operational ,2324400, Q.C DEPARTMENT. , OH , JPI ,," 1,000 ",," 1,000 "
,,,,,,,,,,,
,,,,,,,,,,," 24,520,000 "
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
,,,,,,,,,,,
"""

excel_data_io = io.StringIO(excel_data)

# Use csv reader to handle quoted fields correctly
reader = csv.reader(excel_data_io)
header = next(reader)
data = []
for row in reader:
    # Filter out empty rows at the end of the data
    if any(cell.strip() for cell in row):
        data.append(row)

df = pd.DataFrame(data, columns=header)

# Rename columns for easier access and strip whitespace from column names
df.columns = df.columns.str.strip()
df.rename(columns={
    'Asset Type': 'AssetType',
    'Strategic/ Direct': 'StrategicDirect',
    'Total 2025 FY Original Budget': 'Budget'
}, inplace=True)

# Convert Budget to numeric, handling potential errors and cleaning data
# First, remove any non-numeric characters except for commas and periods
df['Budget'] = df['Budget'].astype(str).str.replace('"', '').str.replace(',', '').astype(float)

# Drop rows where 'AssetType' or 'StrategicDirect' is NaN or empty
df.dropna(subset=['AssetType', 'StrategicDirect', 'Budget'], inplace=True)

# --- Chart 1: Asset Type Breakdown ---
asset_type_breakdown = df.groupby('AssetType')['Budget'].sum().sort_values(ascending=False)

plt.figure(figsize=(10, 7))
plt.pie(asset_type_breakdown, labels=asset_type_breakdown.index, autopct='%1.1f%%', startangle=140)
plt.title('Asset Type Breakdown (2025 FY Original Budget)')
plt.axis('equal') # Equal aspect ratio ensures that pie is drawn as a circle.
plt.tight_layout()
buf1 = io.BytesIO()
plt.savefig(buf1, format='png')
buf1.seek(0)
image_base64_1 = base64.b64encode(buf1.read()).decode('utf-8')
plt.close()

# --- Chart 2: Strategic vs. Direct Priorities ---
strategic_direct_breakdown = df.groupby('StrategicDirect')['Budget'].sum().sort_values(ascending=False)

plt.figure(figsize=(8, 6))
strategic_direct_breakdown.plot(kind='bar', color=['skyblue', 'lightcoral'])
plt.title('Strategic vs. Direct Priorities (2025 FY Original Budget)')
plt.ylabel('Total Budget')
plt.xlabel('Category')
plt.xticks(rotation=0)
plt.tight_layout()
buf2 = io.BytesIO()
plt.savefig(buf2, format='png')
buf2.seek(0)
image_base64_2 = base64.b64encode(buf2.read()).decode('utf-8')
plt.close()

print(f"Chart 1 Base64: {image_base64_1}")
print(f"Chart 2 Base64: {image_base64_2}")
