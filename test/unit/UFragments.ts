import { ethers, upgrades, waffle } from 'hardhat'
import { Contract, Signer, BigNumber } from 'ethers'
import { expect } from 'chai'
import { imul } from '../utils/utils'

const toUFrgDenomination = (ample: string): BigNumber =>
  ethers.utils.parseUnits(ample, DECIMALS)

const DECIMALS = 18
const INITIAL_SUPPLY = ethers.BigNumber.from(0)
const FIRST_MINT_SUPPLY = ethers.utils.parseUnits('50', 6 + DECIMALS)
const INITIAL_EXCHANGE_RATE = ethers.BigNumber.from(10).pow(8)
const MAX_UINT256 = ethers.BigNumber.from(2).pow(256).sub(1)
const MAX_INT256 = ethers.BigNumber.from(2).pow(255).sub(1)
const TOTAL_GONS = 0

const transferAmount = toUFrgDenomination('10')
const unitTokenAmount = toUFrgDenomination('1')

let deployer: Signer, accounts: Signer[]
let uFragments: Contract,
  mockCollateralToken: Contract,
  mockMarketOracle: Contract,
  initialSupply: BigNumber

async function mockedUFragments() {
  // prepare signers
  const accounts = await ethers.getSigners()
  const deployer = accounts[0]
  // deploy upgradable token
  const factory = await ethers.getContractFactory('UFragments')

  const mockCollateralToken = await (
    await ethers.getContractFactory('MockERC20Token')
  )
    .connect(deployer)
    .deploy()
  const mockMarketOracle = await (await ethers.getContractFactory('MockOracle'))
    .connect(deployer)
    .deploy('MarketOracle')
  await mockMarketOracle.storeData(INITIAL_EXCHANGE_RATE)

  const uFragments = await upgrades.deployProxy(
    factory,
    [await deployer.getAddress(), mockCollateralToken.address, 18],
    {
      initializer: 'initialize(address, address, uint256)',
    },
  )

  // setup oracles
  await uFragments.connect(deployer).setMarketOracle(mockMarketOracle.address)

  // fetch initial supply
  const initialSupply = await uFragments.totalSupply()

  return {
    deployer,
    accounts,
    initialSupply,
    uFragments,
    mockCollateralToken,
    mockMarketOracle,
  }
}

async function mintFragments(amount: BigNumber) {
  await mockCollateralToken.mint(await deployer.getAddress(), amount)
  await mockCollateralToken
    .connect(deployer)
    .approve(uFragments.address, amount)
  await uFragments.mint(await deployer.getAddress(), amount)
}

async function setupContracts() {
  ;({
    deployer,
    accounts,
    uFragments,
    mockCollateralToken,
    initialSupply,
    mockMarketOracle,
  } = await waffle.loadFixture(mockedUFragments))
}

describe('UFragments', () => {
  before('setup UFragments contract', setupContracts)

  it('should reject any ether sent to it', async function () {
    const user = accounts[1]
    await expect(user.sendTransaction({ to: uFragments.address, value: 1 })).to
      .be.reverted
  })
})

describe('UFragments:Initialization', () => {
  before('setup UFragments contract', setupContracts)

  it('should start with the totalSupply at 0', async function () {
    expect(await uFragments.totalSupply()).to.eq(INITIAL_SUPPLY)
  })

  it('should set the owner', async function () {
    expect(await uFragments.owner()).to.eq(await deployer.getAddress())
  })

  it('should set detailed ERC20 parameters', async function () {
    expect(await uFragments.name()).to.eq('Ampleforth')
    expect(await uFragments.symbol()).to.eq('AMPL')
    expect(await uFragments.decimals()).to.eq(DECIMALS)
  })
})

describe('UFragments:setMarketOracle', async function () {
  before('setup UFragments contract', setupContracts)

  it('should set marketOracle', async function () {
    await uFragments
      .connect(deployer)
      .setMarketOracle(await deployer.getAddress())
    expect(await uFragments.marketOracle()).to.eq(await deployer.getAddress())
  })
})

describe('UFragments:setMarketOracle:accessControl', function () {
  before('setup UFragments contract', setupContracts)

  it('should be callable by owner', async function () {
    await expect(
      uFragments.connect(deployer).setMarketOracle(await deployer.getAddress()),
    ).to.not.be.reverted
  })

  it('should NOT be callable by non-owner', async function () {
    await expect(
      uFragments
        .connect(accounts[1])
        .setMarketOracle(await deployer.getAddress()),
    ).to.be.reverted
  })
})

describe('UFragments:Rebase:accessControl', async () => {
  before('setup UFragments contract', setupContracts)

  it('should be callable by anyone', async function () {
    await mockMarketOracle.storeData(INITIAL_EXCHANGE_RATE)
    const supply = await uFragments.totalSupply()
    await expect(uFragments.connect(accounts[1]).rebase()).to.not.be.reverted
    await expect(uFragments.connect(accounts[2]).rebase()).to.not.be.reverted
    await expect(uFragments.connect(accounts[3]).rebase()).to.not.be.reverted
  })
})

describe('UFragments:Rebase', async function () {
  before('setup UFragments contract', setupContracts)

  describe('when the market oracle returns invalid data', function () {
    it('should fail', async function () {
      await mockMarketOracle.storeValidity(false)
      await mockMarketOracle.storeData(INITIAL_EXCHANGE_RATE)
      await expect(uFragments.rebase()).to.be.reverted
    })
  })

  describe('when the market oracle returns valid data', function () {
    it('should NOT fail', async function () {
      await mockMarketOracle.storeValidity(true)
      await mockMarketOracle.storeData(INITIAL_EXCHANGE_RATE)
      await expect(uFragments.rebase()).to.not.be.reverted
    })
  })
})

describe('UFragments:Rebase', async function () {
  const INITIAL_RATE_30P_MORE = imul(INITIAL_EXCHANGE_RATE, '1.3', 1)

  beforeEach('setup UFragments contract', async function () {
    await setupContracts()
    await mintFragments(FIRST_MINT_SUPPLY)
    await mockMarketOracle.storeValidity(true)
    await mockMarketOracle.storeData(INITIAL_RATE_30P_MORE)
  })

  describe('rate increases', function () {
    it('should increase supply', async function () {
      const r = uFragments.rebase()
      await expect(r)
        .to.emit(uFragments, 'LogRebase')
        .withArgs(imul(FIRST_MINT_SUPPLY, 1.3, 1))
    })

    it('should call getData from the market oracle', async function () {
      await expect(uFragments.rebase())
        .to.emit(mockMarketOracle, 'FunctionCalled')
        .withArgs('MarketOracle', 'getData', uFragments.address)
    })
  })
})

describe('UFragments:Rebase', async function () {
  const INITIAL_RATE_30P_LESS = imul(INITIAL_EXCHANGE_RATE, '0.7', 1)

  beforeEach('setup UFragments contract', async function () {
    await setupContracts()
    await mintFragments(FIRST_MINT_SUPPLY)
    await mockMarketOracle.storeValidity(true)
    await mockMarketOracle.storeData(INITIAL_RATE_30P_LESS)
  })

  describe('rate decreases', function () {
    it('should decrease supply', async function () {
      const r = uFragments.rebase()
      await expect(r)
        .to.emit(uFragments, 'LogRebase')
        .withArgs(imul(FIRST_MINT_SUPPLY, 0.7, 1))
    })

    it('should call getData from the market oracle', async function () {
      await expect(uFragments.rebase())
        .to.emit(mockMarketOracle, 'FunctionCalled')
        .withArgs('MarketOracle', 'getData', uFragments.address)
    })
  })
})

describe('UFragments:Rebase', async function () {
  beforeEach('setup UFragments contract', async function () {
    await setupContracts()
    await mintFragments(FIRST_MINT_SUPPLY)
    await mockCollateralToken.mint(uFragments.address, FIRST_MINT_SUPPLY)
  })

  describe('collateral balance increases', function () {
    it('should increase supply', async function () {
      const r = uFragments.rebase()
      await expect(r)
        .to.emit(uFragments, 'LogRebase')
        .withArgs(imul(FIRST_MINT_SUPPLY, 2, 1))
    })

    it('should call getData from the market oracle', async function () {
      await expect(uFragments.rebase())
        .to.emit(mockMarketOracle, 'FunctionCalled')
        .withArgs('MarketOracle', 'getData', uFragments.address)
    })
  })
})

describe('UFragments:Rebase', async function () {
  beforeEach('setup UFragments contract', async function () {
    await setupContracts()
    await mintFragments(FIRST_MINT_SUPPLY)
    await mockCollateralToken.burn(uFragments.address, FIRST_MINT_SUPPLY.div(2))
  })

  describe('collateral balance decreases', function () {
    it('should decrease supply', async function () {
      const r = uFragments.rebase()
      await expect(r)
        .to.emit(uFragments, 'LogRebase')
        .withArgs(imul(FIRST_MINT_SUPPLY, 0.5, 1))
    })

    it('should call getData from the market oracle', async function () {
      await expect(uFragments.rebase())
        .to.emit(mockMarketOracle, 'FunctionCalled')
        .withArgs('MarketOracle', 'getData', uFragments.address)
    })
  })
})

describe('UFragments:Rebase', async function () {
  beforeEach('setup UFragments contract', async function () {
    await setupContracts()
    await mintFragments(FIRST_MINT_SUPPLY)
  })

  describe('both rate and collateral balance change', function () {
    it('should rebase properly', async function () {
      // test 100 random combinations of rate and balance
      for (let i = 0; i < 100; i++) {
        const max = 10000
        const min = 0.0001
        const rate = imul(
          INITIAL_EXCHANGE_RATE,
          Math.random() * (max - min) + min,
          1,
        )
        const balance = imul(
          FIRST_MINT_SUPPLY,
          Math.random() * (max - min) + min,
          1,
        )
        const expectedSupply = rate.mul(balance).div(10 ** 8)
        await mockMarketOracle.storeValidity(true)
        await mockMarketOracle.storeData(rate)

        const currentBalance = await mockCollateralToken.balanceOf(
          uFragments.address,
        )
        await mockCollateralToken.burn(uFragments.address, currentBalance)
        await mockCollateralToken.mint(uFragments.address, balance)

        const r = uFragments.rebase()
        await expect(r)
          .to.emit(uFragments, 'LogRebase')
          .withArgs(expectedSupply)
      }
    })
  })
})

describe('UFragments:Rebase:Expansion', async () => {
  // Rebase +5M (10%), with starting balances A:750 and B:250.
  let A: Signer, B: Signer, policy: Signer
  // 10% increase in price = 10% rebase
  const newExchangeRate = INITIAL_EXCHANGE_RATE.add(
    INITIAL_EXCHANGE_RATE.div(10),
  )
  const rebaseAmt = FIRST_MINT_SUPPLY.div(10)
  let supply: BigNumber

  before('setup UFragments contract', async function () {
    await setupContracts()
    A = accounts[2]
    B = accounts[3]
    policy = accounts[1]
    await mintFragments(FIRST_MINT_SUPPLY)
    await uFragments
      .connect(deployer)
      .transfer(await A.getAddress(), toUFrgDenomination('750'))
    await uFragments
      .connect(deployer)
      .transfer(await B.getAddress(), toUFrgDenomination('250'))

    expect(await uFragments.totalSupply()).to.eq(FIRST_MINT_SUPPLY)
    expect(await uFragments.balanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('750'),
    )
    expect(await uFragments.balanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('250'),
    )

    expect(await uFragments.scaledTotalSupply()).to.eq(FIRST_MINT_SUPPLY)
    expect(await uFragments.scaledBalanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('750'),
    )
    expect(await uFragments.scaledBalanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('250'),
    )
    supply = await uFragments.totalSupply()
  })

  it('should emit Rebase', async function () {
    await mockMarketOracle.storeData(newExchangeRate)
    await expect(uFragments.connect(policy).rebase())
      .to.emit(uFragments, 'LogRebase')
      .withArgs(supply.add(rebaseAmt))
  })

  it('should increase the totalSupply', async function () {
    expect(await uFragments.totalSupply()).to.eq(supply.add(rebaseAmt))
  })

  it('should NOT CHANGE the scaledTotalSupply', async function () {
    expect(await uFragments.scaledTotalSupply()).to.eq(supply)
  })

  it('should increase individual balances', async function () {
    expect(await uFragments.balanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('825'),
    )
    expect(await uFragments.balanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('275'),
    )
  })

  it('should NOT CHANGE the individual scaled balances', async function () {
    expect(await uFragments.scaledBalanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('750'),
    )
    expect(await uFragments.scaledBalanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('250'),
    )
  })

  it('should return the new supply', async function () {
    await mockMarketOracle.storeData(newExchangeRate)
    const returnVal = await uFragments.connect(policy).callStatic.rebase()
    await uFragments.connect(policy).rebase()
    expect(await uFragments.totalSupply()).to.eq(returnVal)
  })
})

describe('UFragments:Rebase:Expansion', async function () {
  let policy: Signer
  const MAX_SUPPLY = ethers.BigNumber.from(2).pow(128).sub(1)
  const TOO_HIGH_EXCHANGE_RATE = ethers.BigNumber.from(10)
    .pow(8)
    .mul(1000000000000)

  describe('when totalSupply is less than MAX_SUPPLY and expands beyond', function () {
    before('setup UFragments contract', async function () {
      await setupContracts()
      policy = accounts[1]
      await mintFragments(FIRST_MINT_SUPPLY)
      await mockMarketOracle.storeData(TOO_HIGH_EXCHANGE_RATE)
      const totalSupply = await uFragments.totalSupply.call()
      await uFragments.connect(policy).rebase()
    })

    it('should emit Rebase', async function () {
      await mockMarketOracle.storeData(TOO_HIGH_EXCHANGE_RATE.mul(50))
      await expect(uFragments.connect(policy).rebase())
        .to.emit(uFragments, 'LogRebase')
        .withArgs(MAX_SUPPLY)
    })

    it('should increase the totalSupply to MAX_SUPPLY', async function () {
      expect(await uFragments.totalSupply()).to.eq(MAX_SUPPLY)
    })
  })

  describe('when totalSupply is MAX_SUPPLY and expands', function () {
    before(async function () {
      expect(await uFragments.totalSupply()).to.eq(MAX_SUPPLY)
    })

    it('should emit Rebase', async function () {
      await mockMarketOracle.storeData(TOO_HIGH_EXCHANGE_RATE.mul(50000))
      const supply = await uFragments.totalSupply()
      await expect(uFragments.connect(policy).rebase())
        .to.emit(uFragments, 'LogRebase')
        .withArgs(MAX_SUPPLY)
    })

    it('should NOT change the totalSupply', async function () {
      expect(await uFragments.totalSupply()).to.eq(MAX_SUPPLY)
    })
  })
})

describe('UFragments:Rebase:NoChange', function () {
  // Rebase (0%), with starting balances A:750 and B:250.
  let A: Signer, B: Signer, policy: Signer

  before('setup UFragments contract', async function () {
    await setupContracts()
    A = accounts[2]
    B = accounts[3]
    policy = accounts[1]
    await mintFragments(FIRST_MINT_SUPPLY)
    await uFragments
      .connect(deployer)
      .transfer(await A.getAddress(), toUFrgDenomination('750'))
    await uFragments
      .connect(deployer)
      .transfer(await B.getAddress(), toUFrgDenomination('250'))

    expect(await uFragments.totalSupply()).to.eq(FIRST_MINT_SUPPLY)
    expect(await uFragments.balanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('750'),
    )
    expect(await uFragments.balanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('250'),
    )

    expect(await uFragments.scaledTotalSupply()).to.eq(FIRST_MINT_SUPPLY)
    expect(await uFragments.scaledBalanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('750'),
    )
    expect(await uFragments.scaledBalanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('250'),
    )
  })

  it('should emit Rebase', async function () {
    const supply = await uFragments.totalSupply()
    await expect(uFragments.connect(policy).rebase())
      .to.emit(uFragments, 'LogRebase')
      .withArgs(supply)
  })

  it('should NOT CHANGE the totalSupply', async function () {
    expect(await uFragments.totalSupply()).to.eq(FIRST_MINT_SUPPLY)
  })

  it('should NOT CHANGE the scaledTotalSupply', async function () {
    expect(await uFragments.scaledTotalSupply()).to.eq(FIRST_MINT_SUPPLY)
  })

  it('should NOT CHANGE individual balances', async function () {
    expect(await uFragments.balanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('750'),
    )
    expect(await uFragments.balanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('250'),
    )
  })

  it('should NOT CHANGE the individual scaled balances', async function () {
    expect(await uFragments.scaledBalanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('750'),
    )
    expect(await uFragments.scaledBalanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('250'),
    )
  })
})

describe('UFragments:Rebase:Contraction', function () {
  // Rebase -5M (-10%), with starting balances A:750 and B:250.
  let A: Signer, B: Signer, policy: Signer
  const rebaseAmt = FIRST_MINT_SUPPLY.div(10)
  const newExchangeRate = INITIAL_EXCHANGE_RATE.sub(
    INITIAL_EXCHANGE_RATE.div(10),
  )

  before('setup UFragments contract', async function () {
    await setupContracts()
    A = accounts[2]
    B = accounts[3]
    policy = accounts[1]
    await mintFragments(FIRST_MINT_SUPPLY)
    await uFragments
      .connect(deployer)
      .transfer(await A.getAddress(), toUFrgDenomination('750'))
    await uFragments
      .connect(deployer)
      .transfer(await B.getAddress(), toUFrgDenomination('250'))

    expect(await uFragments.totalSupply()).to.eq(FIRST_MINT_SUPPLY)
    expect(await uFragments.balanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('750'),
    )
    expect(await uFragments.balanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('250'),
    )

    expect(await uFragments.scaledTotalSupply()).to.eq(FIRST_MINT_SUPPLY)
    expect(await uFragments.scaledBalanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('750'),
    )
    expect(await uFragments.scaledBalanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('250'),
    )
  })

  it('should emit Rebase', async function () {
    await mockMarketOracle.storeData(newExchangeRate)
    const supply = await uFragments.totalSupply()
    await expect(uFragments.connect(policy).rebase())
      .to.emit(uFragments, 'LogRebase')
      .withArgs(supply.sub(rebaseAmt))
  })

  it('should decrease the totalSupply', async function () {
    expect(await uFragments.totalSupply()).to.eq(
      FIRST_MINT_SUPPLY.sub(rebaseAmt),
    )
  })

  it('should NOT. CHANGE the scaledTotalSupply', async function () {
    expect(await uFragments.scaledTotalSupply()).to.eq(FIRST_MINT_SUPPLY)
  })

  it('should decrease individual balances', async function () {
    expect(await uFragments.balanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('675'),
    )
    expect(await uFragments.balanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('225'),
    )
  })

  it('should NOT CHANGE the individual scaled balances', async function () {
    expect(await uFragments.scaledBalanceOf(await A.getAddress())).to.eq(
      toUFrgDenomination('750'),
    )
    expect(await uFragments.scaledBalanceOf(await B.getAddress())).to.eq(
      toUFrgDenomination('250'),
    )
  })
})

describe('UFragments:Transfer', function () {
  let A: Signer, B: Signer, C: Signer

  before('setup UFragments contract', async () => {
    await setupContracts()
    A = accounts[2]
    B = accounts[3]
    C = accounts[4]
    await mintFragments(FIRST_MINT_SUPPLY)
  })

  describe('deployer transfers 12 to A', function () {
    it('should have correct balances', async function () {
      const deployerBefore = await uFragments.balanceOf(
        await deployer.getAddress(),
      )
      await uFragments
        .connect(deployer)
        .transfer(await A.getAddress(), toUFrgDenomination('12'))
      expect(await uFragments.balanceOf(await deployer.getAddress())).to.eq(
        deployerBefore.sub(toUFrgDenomination('12')),
      )
      expect(await uFragments.balanceOf(await A.getAddress())).to.eq(
        toUFrgDenomination('12'),
      )
    })
  })

  describe('deployer transfers 15 to B', async function () {
    it('should have balances [973,15]', async function () {
      const deployerBefore = await uFragments.balanceOf(
        await deployer.getAddress(),
      )
      await uFragments
        .connect(deployer)
        .transfer(await B.getAddress(), toUFrgDenomination('15'))
      expect(await uFragments.balanceOf(await deployer.getAddress())).to.eq(
        deployerBefore.sub(toUFrgDenomination('15')),
      )
      expect(await uFragments.balanceOf(await B.getAddress())).to.eq(
        toUFrgDenomination('15'),
      )
    })
  })

  describe('deployer transfers the rest to C', async function () {
    it('should have balances [0,973]', async function () {
      const deployerBefore = await uFragments.balanceOf(
        await deployer.getAddress(),
      )
      await uFragments
        .connect(deployer)
        .transfer(await C.getAddress(), deployerBefore)
      expect(await uFragments.balanceOf(await deployer.getAddress())).to.eq(0)
      expect(await uFragments.balanceOf(await C.getAddress())).to.eq(
        deployerBefore,
      )
    })
  })

  describe('when the recipient address is the contract address', function () {
    it('reverts on transfer', async function () {
      await expect(
        uFragments.connect(A).transfer(uFragments.address, unitTokenAmount),
      ).to.be.reverted
    })

    it('reverts on transferFrom', async function () {
      await expect(
        uFragments
          .connect(A)
          .transferFrom(
            await A.getAddress(),
            uFragments.address,
            unitTokenAmount,
          ),
      ).to.be.reverted
    })
  })

  describe('when the recipient is the zero address', function () {
    it('emits an approval event', async function () {
      await expect(
        uFragments
          .connect(A)
          .approve(ethers.constants.AddressZero, transferAmount),
      )
        .to.emit(uFragments, 'Approval')
        .withArgs(
          await A.getAddress(),
          ethers.constants.AddressZero,
          transferAmount,
        )
    })

    it('transferFrom should fail', async function () {
      await expect(
        uFragments
          .connect(C)
          .transferFrom(
            await A.getAddress(),
            ethers.constants.AddressZero,
            unitTokenAmount,
          ),
      ).to.be.reverted
    })
  })
})
