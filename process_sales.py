
import pandas as pd
import io

# Extract Sales Data from the multi-sheet content
excel_content = """=== Sheet: Sales Data ===
Date,Salesperson,Region,Product,Units Sold,Unit Price,Revenue,Discount %,Net Revenue
2024-03-31,Khalid Omar,Central,Laptop Pro X,31,2500,,0.11,
2024-02-04,Khalid Omar,East,Cloud Server,39,5000,,0.23,
2024-01-03,Mohamed Hassan,Central,Laptop Pro X,26,2500,,0.06,
2024-12-13,Mohamed Hassan,South,Cloud Server,7,5000,,0.22,
2024-12-25,Sara Johnson,South,Wireless Hub,10,350,,0.2,
2024-12-08,Sara Johnson,South,Wireless Hub,41,350,,0.12,
2024-04-11,Ahmed Al-Rashid,South,Cloud Server,14,5000,,0.07,
2024-05-18,Emily Chen,North,Laptop Pro X,30,2500,,0.16,
2024-07-24,Ahmed Al-Rashid,South,Tablet Ultra,38,800,,0.05,
2024-04-23,Emily Chen,North,Wireless Hub,38,350,,0.24,
2024-04-03,Sara Johnson,South,Smart Monitor,33,1200,,0.24,
2024-11-16,Ahmed Al-Rashid,East,Laptop Pro X,43,2500,,0.04,
2024-07-20,Khalid Omar,North,Smart Monitor,15,1200,,0.08,
2024-04-05,Khalid Omar,East,Tablet Ultra,25,800,,0.05,
2024-01-07,Emily Chen,North,Smart Monitor,18,1200,,0.22,
2024-07-12,Ahmed Al-Rashid,East,Cloud Server,41,5000,,0.12,
2024-07-21,Mohamed Hassan,Central,Tablet Ultra,2,800,,0.11,
2024-05-11,Emily Chen,East,Cloud Server,43,5000,,0.19,
2024-06-23,Mohamed Hassan,Central,Laptop Pro X,3,2500,,0.05,
2024-02-23,Emily Chen,South,Tablet Ultra,36,800,,0.23,
2024-08-31,Ahmed Al-Rashid,West,Tablet Ultra,39,800,,0.07,
2024-06-24,Sara Johnson,West,Cloud Server,20,5000,,0.17,
2024-08-04,Mohamed Hassan,East,Wireless Hub,14,350,,0.05,
2024-04-18,Sara Johnson,South,Smart Monitor,27,1200,,0.17,
2024-05-26,Emily Chen,Central,Tablet Ultra,30,800,,0.02,
2024-07-16,Mohamed Hassan,Central,Wireless Hub,9,350,,0.11,
2024-04-06,Mohamed Hassan,East,Wireless Hub,49,350,,0.19,
2024-05-22,Emily Chen,South,Laptop Pro X,41,2500,,0.24,
2024-05-11,Emily Chen,Central,Cloud Server,45,5000,,0.09,
2024-08-04,Sara Johnson,South,Tablet Ultra,14,800,,0.08,
2024-02-03,Emily Chen,Central,Cloud Server,26,5000,,0.24,
2024-08-03,Sara Johnson,South,Laptop Pro X,5,2500,,0.24,
2024-03-20,Sara Johnson,North,Wireless Hub,3,350,,0.01,
2024-04-21,Khalid Omar,East,Tablet Ultra,31,800,,0.12,
2024-04-24,Emily Chen,Central,Laptop Pro X,24,2500,,0.14,
2024-03-18,Ahmed Al-Rashid,South,Laptop Pro X,30,2500,,0.03,
2024-07-11,Emily Chen,North,Smart Monitor,42,1200,,0.21,
2024-08-19,Mohamed Hassan,South,Wireless Hub,25,350,,0.15,
2024-03-19,Emily Chen,Central,Smart Monitor,9,1200,,0.03,
2024-09-15,Emily Chen,North,Smart Monitor,28,1200,,0.04,
2024-07-05,Sara Johnson,West,Tablet Ultra,33,800,,0.14,
2024-04-10,Mohamed Hassan,South,Cloud Server,11,5000,,0.17,
2024-09-18,Ahmed Al-Rashid,West,Laptop Pro X,33,2500,,0.15,
2024-10-26,Sara Johnson,East,Laptop Pro X,48,2500,,0.09,
2024-11-09,Mohamed Hassan,Central,Laptop Pro X,15,2500,,0.2,
2024-06-19,Sara Johnson,South,Cloud Server,31,5000,,0.13,
2024-10-08,Mohamed Hassan,North,Laptop Pro X,6,2500,,0.12,
2024-04-22,Mohamed Hassan,North,Smart Monitor,8,1200,,0.19,
2024-03-20,Mohamed Hassan,East,Laptop Pro X,14,2500,,0.19,
2024-05-21,Ahmed Al-Rashid,East,Smart Monitor,40,1200,,0.19,
2024-12-09,Emily Chen,North,Cloud Server,20,5000,,0.14,
2024-10-12,Mohamed Hassan,Central,Smart Monitor,23,1200,,0.07,
2024-05-14,Ahmed Al-Rashid,South,Wireless Hub,19,350,,0.15,
2024-05-25,Ahmed Al-Rashid,East,Cloud Server,45,5000,,0.24,
2024-03-25,Mohamed Hassan,West,Wireless Hub,17,350,,0.08,
2024-09-18,Sara Johnson,South,Tablet Ultra,8,800,,0.13,
2024-02-10,Sara Johnson,East,Laptop Pro X,43,2500,,0.1,
2024-03-13,Sara Johnson,South,Laptop Pro X,46,2500,,0.13,
2024-09-27,Khalid Omar,North,Wireless Hub,11,350,,0.02,
2024-11-24,Sara Johnson,North,Wireless Hub,9,350,,0.08,
2024-12-22,Mohamed Hassan,North,Tablet Ultra,2,800,,0.14,
2024-09-24,Sara Johnson,North,Laptop Pro X,38,2500,,0.19,
2024-11-28,Emily Chen,East,Laptop Pro X,7,2500,,0.07,
2024-11-11,Emily Chen,Central,Smart Monitor,40,1200,,0.23,
2024-09-22,Khalid Omar,South,Wireless Hub,5,350,,0.23,
2024-05-23,Sara Johnson,West,Tablet Ultra,42,800,,0.01,
2024-08-17,Sara Johnson,South,Laptop Pro X,24,2500,,0.02,
2024-09-29,Khalid Omar,South,Cloud Server,30,5000,,0.15,
2024-12-28,Khalid Omar,Central,Smart Monitor,36,1200,,0.08,
2024-07-04,Ahmed Al-Rashid,North,Smart Monitor,47,1200,,0.2,
2024-06-12,Mohamed Hassan,East,Tablet Ultra,35,800,,0.23,
2024-04-22,Khalid Omar,South,Tablet Ultra,35,800,,0.06,
2024-06-25,Sara Johnson,Central,Cloud Server,11,5000,,0.01,
2024-08-13,Khalid Omar,North,Tablet Ultra,41,800,,0.03,
2024-08-28,Mohamed Hassan,East,Cloud Server,32,5000,,0.1,
2024-09-08,Mohamed Hassan,Central,Smart Monitor,46,1200,,0,
2024-05-30,Khalid Omar,South,Cloud Server,6,5000,,0.11,
2024-11-27,Ahmed Al-Rashid,Central,Smart Monitor,31,1200,,0.18,
2024-08-02,Sara Johnson,East,Tablet Ultra,7,800,,0.06,
2024-03-13,Khalid Omar,West,Smart Monitor,21,1200,,0.05,
2024-04-25,Ahmed Al-Rashid,North,Wireless Hub,37,350,,0.07,
2024-05-28,Sara Johnson,West,Cloud Server,22,5000,,0.03,
2024-01-20,Mohamed Hassan,West,Laptop Pro X,31,2500,,0.22,
2024-04-19,Sara Johnson,North,Laptop Pro X,32,2500,,0.07,
2024-06-20,Mohamed Hassan,South,Tablet Ultra,40,800,,0.02,
2024-02-28,Ahmed Al-Rashid,Central,Tablet Ultra,44,800,,0.017,
2024-07-03,Khalid Omar,East,Laptop Pro X,16,2500,,0.08,
2024-05-18,Emily Chen,Central,Smart Monitor,13,1200,,0.2,
2024-08-28,Ahmed Al-Rashid,East,Cloud Server,31,5000,,0.09,
2024-01-28,Ahmed Al-Rashid,Central,Tablet Ultra,2,800,,0.17,
2024-05-06,Khalid Omar,West,Laptop Pro X,43,2500,,0.22,
2024-06-06,Ahmed Al-Rashid,North,Laptop Pro X,25,2500,,0.21,
2024-03-22,Khalid Omar,North,Cloud Server,30,5000,,0.12,
2024-08-24,Sara Johnson,North,Cloud Server,11,5000,,0.16,
2024-09-07,Emily Chen,North,Tablet Ultra,31,800,,0.04,
2024-04-14,Mohamed Hassan,South,Cloud Server,42,5000,,0.06,
2024-01-28,Emily Chen,North,Laptop Pro X,26,2500,,0.14,
2024-03-10,Ahmed Al-Rashid,East,Cloud Server,28,5000,,0.2,
2024-08-10,Emily Chen,South,Laptop Pro X,13,2500,,0.07,
2024-03-26,Ahmed Al-Rashid,Central,Cloud Server,10,5000,,0.01
TOTAL,,,,,,,,"""

# Find the start and end of the "Sales Data" sheet
sales_data_start = excel_content.find("=== Sheet: Sales Data ===")

sales_data_end = excel_content.find("=== Sheet: HR - Employees ===")

sales_data_csv = excel_content[sales_data_start + len("=== Sheet: Sales Data ==="):sales_data_end].strip()

# Read the sales data into a pandas DataFrame
df_sales = pd.read_csv(io.StringIO(sales_data_csv))

# Fill any empty Discount % values with 0 before calculation
df_sales['Discount %'] = df_sales['Discount %'].fillna(0)

# Calculate Revenue and Net Revenue
df_sales['Revenue'] = df_sales['Units Sold'] * df_sales['Unit Price']
df_sales['Net Revenue'] = df_sales['Revenue'] * (1 - df_sales['Discount %'])

# Overall Sales Performance
total_net_revenue = df_sales['Net Revenue'].sum()

# Sales by Product
sales_by_product = df_sales.groupby('Product')['Net Revenue'].sum().sort_values(ascending=False)

# Sales by Salesperson
sales_by_salesperson = df_sales.groupby('Salesperson')['Net Revenue'].sum().sort_values(ascending=False)

print(f"Total Net Revenue: ${total_net_revenue:,.2f}")
print("\nTop 5 Products by Net Revenue:")
print(sales_by_product.head(5).to_string())
print("\nTop 5 Salespersons by Net Revenue:")
print(sales_by_salesperson.head(5).to_string())
