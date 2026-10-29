FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/LlmGateway.Assistant/LlmGateway.Assistant.csproj src/LlmGateway.Assistant/
RUN dotnet restore src/LlmGateway.Assistant/LlmGateway.Assistant.csproj
COPY src/LlmGateway.Assistant/ src/LlmGateway.Assistant/
RUN dotnet publish src/LlmGateway.Assistant/LlmGateway.Assistant.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE 8080
ENTRYPOINT ["dotnet", "LlmGateway.Assistant.dll"]
